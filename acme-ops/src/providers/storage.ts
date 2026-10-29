import { SpecDeviation } from "../kit/errors";
import type { ProviderHttp } from "../kit/http";
import type { BoxClient } from "./work";

/**
 * Dropbox API v2 (https://www.dropbox.com/developers/documentation/http/documentation).
 *
 * RPC endpoints are `POST https://api.dropboxapi.com/2/<route>` with a JSON body. Content endpoints
 * (upload, download) are `POST https://content.dropboxapi.com/2/files/...` with the arguments as
 * JSON in the `Dropbox-API-Arg` header, the bytes in the body, and download metadata in the
 * `Dropbox-API-Result` response header. Errors are 409 with `error_summary` ("path/not_found/..").
 * Team spaces: set DROPBOX_PATH_ROOT (a namespace id) to address the team root.
 */
export class DropboxClient {
  constructor(
    readonly http: ProviderHttp,
    private readonly contentUrl = "https://content.dropboxapi.com/2",
    private readonly pathRoot?: string,
  ) {}

  private get rootHeader(): Record<string, string> {
    return this.pathRoot ? { "Dropbox-API-Path-Root": headerJson({ ".tag": "root", root: this.pathRoot }) } : {};
  }

  private async rpc<T>(route: string, args: unknown, allow?: number[]): Promise<{ status: number; body: T }> {
    return this.http.request<T>("POST", `/2/${route}`, { json: args, headers: this.rootHeader, ...(allow ? { allow } : {}) });
  }

  /** Metadata for a path or id ("id:..."), or null when it doesn't exist. */
  async getMetadata(path: string): Promise<DropboxEntry | null> {
    const { status, body } = await this.rpc<any>("files/get_metadata", { path }, [409]);
    if (status === 409) {
      if (String(body?.error_summary ?? "").startsWith("path/not_found")) return null;
      throw new SpecDeviation("dropbox", `files/get_metadata 409 without path/not_found: ${body?.error_summary}`);
    }
    return entry(body);
  }

  /** Creates a folder; an existing folder is not an error (Dropbox: 409 path/conflict/folder). */
  async createFolder(path: string): Promise<DropboxEntry> {
    const { status, body } = await this.rpc<any>("files/create_folder_v2", { path, autorename: false }, [409]);
    if (status === 409) {
      const existing = await this.getMetadata(path);
      if (existing?.[".tag"] === "folder") return existing;
      throw new SpecDeviation("dropbox", `files/create_folder_v2 conflict at ${path} is not a folder (${body?.error_summary})`);
    }
    if (!body?.metadata) throw new SpecDeviation("dropbox", "files/create_folder_v2 returned no metadata");
    return entry({ ".tag": "folder", ...body.metadata });
  }

  /** Every entry under a folder (list_folder, then list_folder/continue while has_more). */
  async listFolder(path: string, recursive = false): Promise<DropboxEntry[]> {
    const out: DropboxEntry[] = [];
    let { body } = await this.rpc<any>("files/list_folder", { path, recursive, limit: 2000 });
    for (;;) {
      if (!Array.isArray(body?.entries)) throw new SpecDeviation("dropbox", "files/list_folder returned no entries[]");
      out.push(...body.entries.map(entry));
      if (!body.has_more) return out;
      ({ body } = await this.rpc<any>("files/list_folder/continue", { cursor: body.cursor }));
    }
  }

  /**
   * Uploads bytes (≤ 150 MB; larger files need an upload session). `mode: add` with
   * `autorename: false` never overwrites: an existing name is 409 path/conflict/file.
   */
  async upload(path: string, bytes: Uint8Array): Promise<DropboxEntry | { conflict: true }> {
    const { status, body } = await this.http.request<any>("POST", `${this.contentUrl}/files/upload`, {
      raw: { body: bytes, contentType: "application/octet-stream" },
      headers: { "Dropbox-API-Arg": headerJson({ path, mode: "add", autorename: false, mute: true, strict_conflict: true }), ...this.rootHeader },
      allow: [409],
    });
    if (status === 409) {
      if (String(body?.error_summary ?? "").startsWith("path/conflict")) return { conflict: true };
      throw new SpecDeviation("dropbox", `files/upload 409 without path/conflict: ${body?.error_summary}`);
    }
    if (!body?.id) throw new SpecDeviation("dropbox", "files/upload returned no id");
    return entry({ ".tag": "file", ...body });
  }

  /** A file's bytes, base64, with the metadata Dropbox returns in `Dropbox-API-Result`. */
  async downloadBase64(path: string): Promise<{ base64: string; metadata: DropboxEntry | null }> {
    const res = await this.http.request<string>("POST", `${this.contentUrl}/files/download`, { headers: { "Dropbox-API-Arg": headerJson({ path }), ...this.rootHeader }, responseType: "base64" });
    const meta = res.headers?.["dropbox-api-result"];
    return { base64: res.body, metadata: meta ? entry({ ".tag": "file", ...JSON.parse(meta) }) : null };
  }

  /** Shared links the user can see, optionally for one path (sharing/list_shared_links, cursor paging). */
  async listSharedLinks(path?: string): Promise<DropboxSharedLink[]> {
    const out: DropboxSharedLink[] = [];
    let cursor: string | undefined;
    do {
      const { body } = await this.rpc<any>("sharing/list_shared_links", { ...(path ? { path } : {}), ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(body?.links)) throw new SpecDeviation("dropbox", "sharing/list_shared_links returned no links[]");
      out.push(...body.links);
      cursor = body.has_more ? body.cursor : undefined;
    } while (cursor);
    return out;
  }

  /** Narrows a link: an expiry and/or a team-only audience (sharing/modify_shared_link_settings). */
  async modifySharedLink(url: string, settings: { expires?: string; audience?: "public" | "team" | "no_one" }): Promise<DropboxSharedLink> {
    const { body } = await this.rpc<any>("sharing/modify_shared_link_settings", { url, settings: { ...(settings.expires ? { expires: settings.expires.replace(/\.\d{3}Z$/, "Z") } : {}), ...(settings.audience ? { audience: { ".tag": settings.audience } } : {}) } });
    if (!body?.url) throw new SpecDeviation("dropbox", "sharing/modify_shared_link_settings returned no url");
    return body;
  }

  async revokeSharedLink(url: string): Promise<void> {
    await this.rpc("sharing/revoke_shared_link", { url });
  }
}

export interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  server_modified?: string;
  size?: number;
}

export interface DropboxSharedLink {
  ".tag": "file" | "folder";
  url: string;
  name: string;
  id?: string;
  path_lower?: string;
  expires?: string;
  link_permissions?: {
    resolved_visibility?: { ".tag": string };
    effective_audience?: { ".tag": string };
    require_password?: boolean;
  };
}

function entry(e: any): DropboxEntry {
  if (!e || typeof e.name !== "string") throw new SpecDeviation("dropbox", "metadata without a name");
  return e;
}

/** Dropbox-API-Arg must be HTTP-header-safe JSON: characters above 0x7F escaped as \uXXXX. */
export const headerJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// ---------------------------------------------------------------------------
// DocumentStore: one filing interface over Box and Dropbox. A workflow's
// policy names the store and the folder layout; the workflow code never does.
// ---------------------------------------------------------------------------

export interface StoredDocument {
  provider: "box" | "dropbox";
  /** Box file id, or Dropbox "id:..." */
  id: string;
  name: string;
  /** Logical path below the store's root, e.g. "Legal/Agreements/2026/Globex". */
  path: string;
}

export interface DocumentStore {
  readonly provider: "box" | "dropbox";
  /** The file at `folder/name`, if it exists. */
  find(folder: string, name: string): Promise<StoredDocument | null>;
  /**
   * Files `bytes` at `folder/name`, creating folders as needed. Never overwrites: an existing file
   * of that name is returned with `existed: true` (so a retried filing is a no-op).
   */
  put(folder: string, name: string, bytes: Uint8Array): Promise<StoredDocument & { existed: boolean }>;
}

const segments = (folder: string) => folder.split("/").map((s) => s.trim()).filter(Boolean);
/** A name both stores accept: no slashes, backslashes or control characters; at most 200 chars. */
export const safeName = (s: string) => s.replace(/[\\/\u0000-\u001f<>:"|?*]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "untitled";

export class BoxDocumentStore implements DocumentStore {
  readonly provider = "box" as const;
  constructor(private readonly box: BoxClient, private readonly rootFolderId: string) {}

  /** Walks (and creates) the folder path from the root; returns the leaf folder id. */
  private async folderId(folder: string, create: boolean): Promise<string | null> {
    let id = this.rootFolderId;
    for (const name of segments(folder)) {
      const find = async () => (await this.box.folderItems(id)).find((i) => i.type === "folder" && i.name === name)?.id;
      let child = await find();
      if (!child && create) {
        const made = await this.box.createFolder(id, name);
        child = "conflict" in made ? await find() : made.id;
      }
      if (!child) return null;
      id = child;
    }
    return id;
  }

  async find(folder: string, name: string): Promise<StoredDocument | null> {
    const id = await this.folderId(folder, false);
    if (!id) return null;
    const f = (await this.box.folderItems(id)).find((i) => i.type === "file" && i.name === name);
    return f ? { provider: "box", id: f.id, name: f.name, path: segments(folder).join("/") } : null;
  }

  async put(folder: string, name: string, bytes: Uint8Array): Promise<StoredDocument & { existed: boolean }> {
    const id = (await this.folderId(folder, true))!;
    const existing = (await this.box.folderItems(id)).find((i) => i.type === "file" && i.name === name);
    const path = segments(folder).join("/");
    if (existing) return { provider: "box", id: existing.id, name, path, existed: true };
    const f = await this.box.uploadBytes(id, name, bytes);
    return { provider: "box", id: f.id, name: f.name, path, existed: false };
  }
}

export class DropboxDocumentStore implements DocumentStore {
  readonly provider = "dropbox" as const;
  /** `root` is a Dropbox path such as "/Acme" ("" for the account or team root). */
  constructor(private readonly dropbox: DropboxClient, private readonly root: string) {}

  private full(folder: string, name?: string) {
    return [this.root.replace(/\/+$/, ""), ...segments(folder), ...(name ? [name] : [])].join("/").replace(/^(?!\/)/, "/");
  }

  async find(folder: string, name: string): Promise<StoredDocument | null> {
    const e = await this.dropbox.getMetadata(this.full(folder, name));
    return e && e[".tag"] === "file" ? { provider: "dropbox", id: e.id, name: e.name, path: segments(folder).join("/") } : null;
  }

  async put(folder: string, name: string, bytes: Uint8Array): Promise<StoredDocument & { existed: boolean }> {
    const path = segments(folder).join("/");
    // Dropbox creates parent folders on upload; an existing name is a conflict, never an overwrite.
    const up = await this.dropbox.upload(this.full(folder, name), bytes);
    if ("conflict" in up) {
      const e = await this.dropbox.getMetadata(this.full(folder, name));
      if (!e || e[".tag"] !== "file") throw new SpecDeviation("dropbox", `upload conflict at ${this.full(folder, name)} but no file there`);
      return { provider: "dropbox", id: e.id, name: e.name, path, existed: true };
    }
    return { provider: "dropbox", id: up.id, name: up.name, path, existed: false };
  }
}

/** The document store a policy names, or undefined when that provider isn't configured. */
export function documentStore(providers: { box?: BoxClient; dropbox?: DropboxClient }, cfg: { provider: "box" | "dropbox"; root: string }): DocumentStore | undefined {
  if (cfg.provider === "box") return providers.box && new BoxDocumentStore(providers.box, cfg.root);
  return providers.dropbox && new DropboxDocumentStore(providers.dropbox, cfg.root);
}
