#!/usr/bin/env bash
# Install and start the site as a systemd user service.
#   scripts/install-service.sh            install, enable and start
#   scripts/install-service.sh --remove   stop, disable and delete the unit
# The unit in systemd/ holds @REPO@ and @NODE@ placeholders. They are filled in here.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit="pairpost-site.service"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now "$unit" 2>/dev/null || true
  rm -f "$dest/$unit"
  systemctl --user daemon-reload
  echo "removed $unit"
  exit 0
fi

# process.execPath is the real binary even when `node` is a version-manager shim.
node_bin="$(node -p 'process.execPath')"
[[ -x "$node_bin" ]] || { echo "node not found" >&2; exit 1; }

mkdir -p "$dest"
sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_bin|g" "$repo/systemd/$unit" >"$dest/$unit"
systemctl --user daemon-reload
systemctl --user enable --now "$unit"
sleep 1
systemctl --user --no-pager --lines=5 status "$unit" || true
