#!/usr/bin/env bash
# Fail if any tracked or untracked-but-not-ignored text file contains a private host name,
# address, personal name, internal path, internal identifier or internal-design wording.
# Run before every commit: scripts/check-public.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The tailnet address range. The documented CIDR and the exact synthetic literals in the server test
# (range boundaries, the well-known service address, a deliberately invalid address) are not real hosts.
ip_pattern='\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'

# Case-insensitive patterns. Index 2 must stay the address pattern, scan() special-cases it.
ci_patterns=(
  'ts\.net'
  '\btail[0-9a-f]{4,}\b'
  "$ip_pattern"
  'fd7a:'
  '/home/'
  '/Users/'
  'secrets\.env'
  'AGENTS\.md'
)
# Case-sensitive patterns: decision, finding and slice codes.
cs_patterns=(
  '\b[DFTRQ][0-9]{1,2}\b'
  '\bS[1-4]\b'
)

# Private terms (names, hosts, internal paths and project words) are not kept in this repository, because
# a list of them would disclose them. They live in an untracked file, one extended regular expression per
# line, case-insensitive unless the line starts with "cs:". Blank lines and lines starting with # are ignored.
# The file is .private-denylist next to the repository root, or the path in PAIRPOST_PRIVATE_DENYLIST.
# A hit is reported by file, line and rule number only, never the pattern or the matched text.
private_file="${PAIRPOST_PRIVATE_DENYLIST:-.private-denylist}"
private_patterns=()
if [[ -f "$private_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    private_patterns+=("$line")
  done <"$private_file"
else
  echo "check-public: no private denylist at $private_file, checking the generic rules only" >&2
fi

self="scripts/check-public.sh"
fail=0
# The documented Tailscale range 100.64.0.0/10 is public information, so it is blanked out
# before matching. Any single address inside the range is still reported.
scan() {
  local flags="$1" p="$2" file="$3" out
  if [[ "$p" == "${ci_patterns[2]}" ]]; then
    # The documented CIDR is public. Exact quoted test literals are synthetic.
    # Keep line numbers and still scan every remaining address on those lines.
    out=$(sed -E 's@(^|[^0-9.])100\.64\.0\.0/10([^0-9]|$)@\1public-address-range\2@g' -- "$file" |
      {
        if [[ "$file" == 'test/serve.test.mjs' ]]; then
          sed -E "s/'(100\.64\.0\.1|100\.114\.85\.26|100\.127\.255\.254|100\.64\.0\.256|100\.100\.100\.100)'/'synthetic-address'/g"
        else
          cat
        fi
      } | grep -I -n $flags -E -e "$p" || true)
  else
    out=$(grep -I -n $flags -E -e "$p" -- "$file" || true)
  fi
  if [[ -n "$out" ]]; then
    while IFS= read -r line; do echo "$file:$line  [pattern: $p]"; done <<<"$out"
    fail=1
  fi
}
private_scan() {
  local n="$1" rule="$2" file="$3" flags="-i" out
  if [[ "$rule" == cs:* ]]; then flags=""; rule="${rule#cs:}"; fi
  out=$(grep -I -n $flags -E -e "$rule" -- "$file" | cut -d: -f1 || true)
  if [[ -n "$out" ]]; then
    while IFS= read -r line; do echo "$file:$line  [private rule $n]"; done <<<"$out"
    fail=1
  fi
}
while IFS= read -r file; do
  [[ "$file" == "$self" || "$file" == "$private_file" || ! -f "$file" ]] && continue
  for p in "${ci_patterns[@]}"; do scan "-i" "$p" "$file"; done
  for p in "${cs_patterns[@]}"; do scan "" "$p" "$file"; done
  n=0
  for p in "${private_patterns[@]+"${private_patterns[@]}"}"; do n=$((n + 1)); private_scan "$n" "$p" "$file"; done
done < <(git ls-files -co --exclude-standard)

if [[ $fail -ne 0 ]]; then echo "check-public: FAILED" >&2; exit 1; fi
echo "check-public: ok"
