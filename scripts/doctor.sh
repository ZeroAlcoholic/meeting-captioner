#!/usr/bin/env bash
# scripts/doctor.sh — Read-only environment health check.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

declare -a labels statuses details
fail_count=0
warn_count=0

add() {
  labels+=("$1"); statuses+=("$2"); details+=("$3")
  [[ "$2" == "FAIL" ]] && fail_count=$((fail_count+1))
  [[ "$2" == "WARN" ]] && warn_count=$((warn_count+1))
}

have() { command -v "$1" >/dev/null 2>&1; }
ver()  { "$@" 2>/dev/null | head -n1; }

if have git;    then add 'git'    'OK'   "$(ver git --version)"; else add 'git' 'FAIL' 'not installed'; fi
if have node;   then add 'node'   'OK'   "$(node --version)";    else add 'node' 'FAIL' 'not installed'; fi
if have pnpm;   then add 'pnpm'   'OK'   "$(pnpm --version)";    else add 'pnpm' 'FAIL' 'not installed'; fi
if have python3; then add 'python' 'OK'  "$(python3 --version)"
elif have python; then add 'python' 'OK' "$(python --version)"
else                  add 'python' 'WARN' 'not installed (only needed for P3+ offline)'
fi
if have uv;     then add 'uv'     'OK'   "$(uv --version)";      else add 'uv' 'WARN' 'not installed (only needed for P3+ offline)'; fi

[[ -f .env ]]                       && add '.env'         'OK'   'present' || add '.env'         'WARN' 'missing (run setup.sh)'
[[ -f pnpm-lock.yaml ]]             && add 'pnpm-lock'    'OK'   'present' || add 'pnpm-lock'    'WARN' 'missing (run pnpm install)'
[[ -d node_modules ]]               && add 'node_modules' 'OK'   'present' || add 'node_modules' 'WARN' 'missing (run pnpm install)'
[[ -d services/offline/.venv ]]     && add 'py venv'      'OK'   'present' || add 'py venv'      'WARN' 'missing (cd services/offline && uv sync)'

check_port() {
  local port=$1
  local in_use=0
  if have lsof; then
    lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1 && in_use=1
  elif have ss; then
    ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q . && in_use=1
  fi
  if [[ "$in_use" == "1" ]]; then add "port $port" 'WARN' 'in use'
  else                            add "port $port" 'OK'   'free'
  fi
}
check_port 5173
check_port 8787
check_port 8000

printf '\n\033[36mDoctor report\033[0m\n'
for i in "${!labels[@]}"; do
  case "${statuses[$i]}" in
    OK)   printf '  \033[32m[OK]  \033[0m %-14s %s\n' "${labels[$i]}" "${details[$i]}" ;;
    WARN) printf '  \033[33m[WARN]\033[0m %-14s %s\n' "${labels[$i]}" "${details[$i]}" ;;
    FAIL) printf '  \033[31m[FAIL]\033[0m %-14s %s\n' "${labels[$i]}" "${details[$i]}" ;;
  esac
done

echo
if [[ "$fail_count" -gt 0 ]]; then
  printf '\033[31m  %d fail / %d warn — fix FAILs before running dev.\033[0m\n' "$fail_count" "$warn_count"
  exit 1
fi
if [[ "$warn_count" -gt 0 ]]; then
  printf '\033[33m  %d warn — you can run pnpm dev, but some features may be unavailable.\033[0m\n' "$warn_count"
else
  printf '\033[32m  all green\033[0m\n'
fi
