#!/bin/sh
# Installs (or re-pins) omp's SDK for the gateway's omp-native mode into
# gateway/omp-sdk/node_modules. Needed only with an `omp:` block in the config.
#
#   scripts/install-omp-sdk.sh            install the pinned version (gateway/omp-sdk/bun.lock)
#   scripts/install-omp-sdk.sh 18.21.0    re-pin to the omp version now installed, then install
#
# The install runs in a throwaway isb sandbox with only gateway/omp-sdk mounted
# (packages are fetched and unpacked there, with no access to the host's
# credentials); the host only gets the resulting files. Restart the gateway after:
#   systemctl --user restart subagent-models
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
sdk="$here/gateway/omp-sdk"
version="${1:-}"
name="omp-sdk-install-$$"
if [ -n "$version" ]; then
  case "$version" in *[!0-9.]*|'') echo "version must look like 18.21.0" >&2; exit 2;; esac
  tmp=$(mktemp "$sdk/package.json.XXXXXX")
  sed -E "s/(\"@oh-my-pi\/pi-(ai|coding-agent)\": )\"[^\"]*\"/\1\"$version\"/" "$sdk/package.json" > "$tmp" && mv "$tmp" "$sdk/package.json"
  frozen=""
else
  frozen="--frozen-lockfile"
fi
isb create --image dev-base --idmap auto -l owner=subagent-models -v "$sdk:/home/dev/omp-sdk" "$name" >/dev/null
trap 'isb rm -f "$name" >/dev/null 2>&1 || true' EXIT
isb exec "$name" -- su - dev -c "mise use -g bun@1.4.4 >/dev/null 2>&1; export PATH=\$HOME/.local/share/mise/shims:\$PATH; cd ~/omp-sdk && bun install --exact $frozen"
echo "installed: $(grep -o '"version": *"[^"]*"' "$sdk/node_modules/@oh-my-pi/pi-coding-agent/package.json")"
