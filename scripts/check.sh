#!/usr/bin/env bash
# Run the local checks: unit tests, the public-content scan and, when the service is up,
# a few HTTP probes. Usage: scripts/check.sh [base-url]   (default http://127.0.0.1:5190)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
base="${1:-http://127.0.0.1:5190}"

node --test
node scripts/check-skill.mjs
scripts/check-public.sh

for path in / /style.css /app.js /mailbox.html /mailbox.css /mailbox.js /skill/SKILL.md /docs/ /docs/protocol-overview.md /docs/threat-model.md /docs/install/claude-code.md /docs/install/codex.md /docs/daemon.md /LICENSE /assets/mascot.svg; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base$path" || true)"
  printf '%s %s\n' "$code" "$path"
  [[ "$code" == "200" ]] || { echo "check: $path returned $code" >&2; exit 1; }
done
curl -sI "$base/" | grep -i -E '^(content-security-policy|x-content-type-options|referrer-policy|permissions-policy):' >/dev/null
echo "check: ok"
echo "Browser checks (optional): PLAYWRIGHT_CORE=<dir of playwright-core> node scripts/check-page.mjs"
