"""Publish a bundled Node workflow over an existing, digest-pinned ARM64 image.

Reuses the deployment's OS/runtime layers. The only filesystem changes are the
locally compiled JavaScript bundle and map. No secrets or runtime environment
are copied. Useful when the local Docker daemon is unavailable.
"""
import argparse
import datetime
import gzip
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
import urllib.request

import boto3

p = argparse.ArgumentParser()
p.add_argument("--profile", required=True)
p.add_argument("--region", required=True)
p.add_argument("--base-image", required=True)
p.add_argument("--workflow", required=True)
p.add_argument("--out", required=True)
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(a.out)
out.mkdir(parents=True, exist_ok=True, mode=0o700)
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
assert not subprocess.check_output(["git", "status", "--porcelain", "--", "src", "infra"], cwd=root).strip(), "Commit the deployment source first"
host, image = a.base_image.split("/", 1)
repository, digest = image.split("@", 1)
assert digest.startswith("sha256:")
ecr = boto3.Session(profile_name=a.profile, region_name=a.region).client("ecr")
base = ecr.batch_get_image(repositoryName=repository, imageIds=[{"imageDigest": digest}])["images"][0]
manifest = json.loads(base["imageManifest"])
assert manifest["mediaType"] == "application/vnd.docker.distribution.manifest.v2+json"
token = ecr.get_authorization_token()["authorizationData"][0]["authorizationToken"]
request = urllib.request.Request(f"https://{host}/v2/{repository}/blobs/{manifest['config']['digest']}", headers={"Authorization": "Basic " + token})
with urllib.request.urlopen(request, timeout=60) as response:
    config_bytes = response.read()
assert "sha256:" + hashlib.sha256(config_bytes).hexdigest() == manifest["config"]["digest"]
config = json.loads(config_bytes)
assert config["architecture"] == "arm64" and config["os"] == "linux"
payload = io.BytesIO()
hashes = {}
with tarfile.open(fileobj=payload, mode="w") as archive:
    for name in ["main.mjs", "main.mjs.map"]:
        data = (root / "dist" / name).read_bytes()
        info = tarfile.TarInfo("app/dist/" + name)
        info.size, info.mode, info.uid, info.gid = len(data), 0o644, 1000, 1000
        archive.addfile(info, io.BytesIO(data))
        hashes[info.name] = hashlib.sha256(data).hexdigest()
raw = payload.getvalue()
layer = gzip.compress(raw, mtime=0)
config["rootfs"]["diff_ids"].append("sha256:" + hashlib.sha256(raw).hexdigest())
env = [v for v in config["config"].get("Env", []) if not v.startswith("WORKFLOW=")]
config["config"]["Env"] = env + ["WORKFLOW=" + a.workflow]
config["config"].setdefault("Labels", {}).update({"org.opencontainers.image.revision": revision, "acme.workflow": a.workflow})
config.setdefault("history", []).append({"created_by": "Locally compiled workflow bundle " + revision})
config["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
new_config = json.dumps(config, separators=(",", ":")).encode()

def upload(data):
    sha = "sha256:" + hashlib.sha256(data).hexdigest()
    if ecr.batch_check_layer_availability(repositoryName=repository, layerDigests=[sha]).get("layers"):
        return sha
    uid = ecr.initiate_layer_upload(repositoryName=repository)["uploadId"]
    for offset in range(0, len(data), 5 * 1024 * 1024):
        part = data[offset:offset + 5 * 1024 * 1024]
        ecr.upload_layer_part(repositoryName=repository, uploadId=uid, partFirstByte=offset, partLastByte=offset + len(part) - 1, layerPartBlob=part)
    ecr.complete_layer_upload(repositoryName=repository, uploadId=uid, layerDigests=[sha])
    return sha

config_digest, layer_digest = upload(new_config), upload(layer)
manifest["config"].update(digest=config_digest, size=len(new_config))
manifest["layers"].append({"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip", "digest": layer_digest, "size": len(layer)})
tag = "cancellation-" + revision
image = ecr.put_image(repositoryName=repository, imageTag=tag, imageManifest=json.dumps(manifest, separators=(",", ":")))["image"]
result = {"source_commit": revision, "base_image": a.base_image, "architecture": "arm64", "repository": repository, "tag": tag, "image_digest": image["imageId"]["imageDigest"], "image_uri": f"{host}/{repository}:{tag}", "base_layers_preserved": len(manifest["layers"]) - 1, "overlay_file_hashes": hashes}
(out / "image-provenance.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
