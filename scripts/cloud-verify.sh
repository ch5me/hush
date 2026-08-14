#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Setup-only authority must never be needed by task-phase verification.
unset NPM_TOKEN SOPS_AGE_KEY
export PATH="$PWD/.cloud-work/tools/bin:$PATH"

readonly STAGE_TIMEOUT_SECONDS="${HUSH_CLOUD_VERIFY_STAGE_TIMEOUT_SECONDS:-900}"

timeout_bin="$(command -v timeout || command -v gtimeout || true)"
if [ -z "$timeout_bin" ]; then
  printf 'cloud-verify: timeout or gtimeout is required to bound verification\n' >&2
  exit 20
fi

run_stage() {
  local name="$1"
  shift
  local started now rc
  started="$(date +%s)"
  printf 'CLOUD_STAGE %s t+0s status=started\n' "$name"
  if "$timeout_bin" --foreground --signal=TERM --kill-after=10s \
    "$STAGE_TIMEOUT_SECONDS" "$@"; then
    now="$(date +%s)"
    printf 'CLOUD_STAGE %s t+%ss status=passed\n' "$name" "$((now - started))"
    return 0
  else
    rc=$?
    now="$(date +%s)"
    printf 'CLOUD_STAGE %s t+%ss status=failed exit=%s duration=%ss\n' \
      "$name" "$((now - started))" "$rc" "$((now - started))" >&2
    return "$rc"
  fi
}

run_stage lint bun run lint
run_stage format bun run format:check
run_stage type-check bun run type-check
run_stage build bun run build
run_stage test bun run cli:test
