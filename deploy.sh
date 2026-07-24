#!/usr/bin/env bash
# Deploy extensions from this repo into VSCodium (~/.vscode-oss/extensions).
# Usage: ./deploy.sh [claude-auto-accept|claude-session-manager|loom-session-tracker ...]
# With no args, deploys the two plain-JS extensions. loom-session-tracker needs
# a compiled out/ (npm install && npx tsc -p .) before deploying.
set -euo pipefail
cd "$(dirname "$0")"
EXTROOT=~/.vscode-oss/extensions

deploy() {
  local name="$1" publisher version dest
  publisher=$(python3 -c "import json;print(json.load(open('$name/package.json'))['publisher'])")
  version=$(python3 -c "import json;print(json.load(open('$name/package.json'))['version'])")
  dest="$EXTROOT/$publisher.$name-$version"
  if [ "$name" = "loom-session-tracker" ] && [ ! -d "$name/out" ]; then
    echo "SKIP $name: no out/ — run: (cd $name && npm install && npx tsc -p .)" >&2
    return 1
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -r "$name"/. "$dest"/
  rm -rf "$dest/node_modules" 2>/dev/null || true
  if [ "$name" = "loom-session-tracker" ]; then
    # runtime dep: bundle ws (dereference — repo node_modules may be a symlink to the toolchain copy)
    mkdir -p "$dest/node_modules"
    cp -rL "$name/node_modules/ws" "$dest/node_modules/ws"
  fi
  python3 - "$publisher.$name" "$version" "$dest" <<'EOF'
import json, os, sys, time
ident, version, loc = sys.argv[1], sys.argv[2], sys.argv[3]
p = os.path.expanduser('~/.vscode-oss/extensions/extensions.json')
exts = [e for e in json.load(open(p)) if e.get('identifier', {}).get('id') != ident]
exts.append({
  "identifier": {"id": ident}, "version": version,
  "location": {"$mid": 1, "fsPath": loc, "external": "file://" + loc, "path": loc, "scheme": "file"},
  "relativeLocation": os.path.basename(loc),
  "metadata": {"installedTimestamp": int(time.time()*1000), "pinned": False, "source": "vsix",
               "targetPlatform": "undefined", "updated": False, "private": False,
               "isPreReleaseVersion": False, "hasPreReleaseVersion": False}})
json.dump(exts, open(p, 'w'))
EOF
  echo "deployed $publisher.$name-$version -> $dest"
}

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(claude-auto-accept claude-session-manager claude-chat-reader)
for t in "${targets[@]}"; do deploy "$t"; done
echo "Reload VSCodium to pick up changes."
