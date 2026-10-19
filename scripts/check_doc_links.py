#!/usr/bin/env python3
"""Check local targets in the public workflow docs (not external URLs or anchors)."""
import pathlib,re,urllib.parse,json
ROOT=pathlib.Path(__file__).resolve().parents[1]
files=[ROOT/x for x in ['README.md','AGENTS.md','CLAUDE.md','TESTING.md','acme-ops/README.md','customer-ops-agents/README.md']]
files+=list((ROOT/'docs').rglob('*.md'));bad=[];checked=0
for f in files:
 for link in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',f.read_text()):
  link=link.strip().split(' "')[0].strip('<>');u=urllib.parse.urlsplit(link)
  if u.scheme or link.startswith('#'):continue
  target=(f.parent/urllib.parse.unquote(u.path)).resolve()
  if not target.exists():bad.append(f'{f.relative_to(ROOT)}: {link}')
  checked+=1
if bad:raise SystemExit('Missing local documentation targets:\n'+'\n'.join(bad))
# Prevent a new Acme workflow silently missing from the catalog.
catalog=(ROOT/'docs/WORKFLOWS.md').read_text()
for source in (ROOT/'acme-ops/src/workflows').glob('*.ts'):
 if source.stem!='shared' and f'workflows/{source.stem}.md' not in catalog:raise SystemExit('Catalog missing '+source.stem)
for f in ['AGENTS.md','CLAUDE.md','.cursor/rules/fetchsandbox-verification.mdc','docs/VERIFICATION.md','.github/pull_request_template.md']:
 if not (ROOT/f).exists():raise SystemExit('Agent/contributor discovery file missing: '+f)
root_mcp=json.loads((ROOT/'.mcp.json').read_text())
assert root_mcp==json.loads((ROOT/'.cursor/mcp.json').read_text()), 'MCP client configuration drift'
assert root_mcp['mcpServers']['fetchsandbox']['args']==['-y','fetchsandbox-mcp@0.7.30']
assert 'fetchsandbox-mcp@0.7.30' in (ROOT/'acme-ops/verify/relay-proof.mjs').read_text()
print(f'Checked {checked} local link targets across {len(files)} files and Acme catalog/discovery coverage. External URLs and fragment anchors are not validated.')
