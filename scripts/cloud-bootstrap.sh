#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

readonly CLOUD_TOOLS_BIN="$PWD/.cloud-work/tools/bin"
export PATH="$CLOUD_TOOLS_BIN:$PATH"

stage() {
  local name="$1"
  shift
  local started now rc
  started="$(date +%s)"
  printf 'CLOUD_STAGE %s t+0s status=started\n' "$name"
  if "$@"; then
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

verify_toolchain() {
  local expected_node expected_bun actual_node actual_bun
  expected_node="$(tr -d '[:space:]' <.nvmrc)"
  expected_bun="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
  actual_node="$(node --version 2>/dev/null || true)"
  actual_bun="$(bun --version 2>/dev/null || true)"

  if [ "$actual_node" != "v${expected_node}" ]; then
    printf 'cloud-bootstrap: Node v%s required; found %s\n' \
      "$expected_node" "${actual_node:-MISSING}" >&2
    return 20
  fi
  if [ "$actual_bun" != "$expected_bun" ]; then
    printf 'cloud-bootstrap: Bun %s required; found %s\n' \
      "$expected_bun" "${actual_bun:-MISSING}" >&2
    return 21
  fi
}

install_crypto_tools() {
  if [ "$(uname -s)" != "Linux" ]; then
    command -v sops >/dev/null 2>&1 && command -v age >/dev/null 2>&1 && return 0
    printf 'cloud-bootstrap: sops and age must already be installed outside Linux containers\n' >&2
    return 24
  fi

  local arch sops_sha age_sha temp_dir
  case "$(uname -m)" in
    x86_64 | amd64)
      arch="amd64"
      sops_sha="154dfe4cd70554bdd82b98e4cd4acf191d43d01ead6f00a73477aa44c4ac42ef"
      age_sha="2ae71cb3ea761118937a944083f057cfd42f0ef11d197ce72fc2b8780d50c4ef"
      ;;
    aarch64 | arm64)
      arch="arm64"
      sops_sha="78abf2e15c86250a1553ae6f53aba96be6b2a8126f160b1534959add3467ad76"
      age_sha="d25a81f3ac011884009d18362eeb8154ce1bca4d151834c35c718654bd6c6353"
      ;;
    *)
      printf 'cloud-bootstrap: unsupported Linux architecture: %s\n' "$(uname -m)" >&2
      return 25
      ;;
  esac

  if [ "$(sops --version 2>/dev/null | head -n1)" = "sops 3.13.2" ] &&
    [ "$(age --version 2>/dev/null | head -n1)" = "v1.2.0" ]; then
    return 0
  fi

  command -v curl >/dev/null 2>&1 || {
    printf 'cloud-bootstrap: curl is required to install sops and age\n' >&2
    return 26
  }
  command -v sha256sum >/dev/null 2>&1 || {
    printf 'cloud-bootstrap: sha256sum is required to verify sops and age\n' >&2
    return 27
  }

  mkdir -p "$CLOUD_TOOLS_BIN"
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/hush-cloud-tools.XXXXXX")"
  (
    set -e
    trap 'rm -rf "$temp_dir"' EXIT

    curl -fsSL \
      "https://github.com/getsops/sops/releases/download/v3.13.2/sops-v3.13.2.linux.${arch}" \
      -o "$temp_dir/sops"
    printf '%s  %s\n' "$sops_sha" "$temp_dir/sops" | sha256sum -c -

    curl -fsSL \
      "https://github.com/FiloSottile/age/releases/download/v1.2.0/age-v1.2.0-linux-${arch}.tar.gz" \
      -o "$temp_dir/age.tar.gz"
    printf '%s  %s\n' "$age_sha" "$temp_dir/age.tar.gz" | sha256sum -c -
    tar -xzf "$temp_dir/age.tar.gz" -C "$temp_dir"

    install -m 0755 "$temp_dir/sops" "$CLOUD_TOOLS_BIN/sops"
    install -m 0755 "$temp_dir/age/age" "$CLOUD_TOOLS_BIN/age"
    install -m 0755 "$temp_dir/age/age-keygen" "$CLOUD_TOOLS_BIN/age-keygen"
  )
}

verify_registry_auth() {
  if [ -z "${NPM_TOKEN:-}" ]; then
    printf '%s\n' \
      'cloud-bootstrap: NPM_TOKEN is required during setup to install @ch5me packages from npm.ch5.me.' \
      'cloud-bootstrap: Keep it setup-only; Cloud Work must remove it before the task phase.' >&2
    return 22
  fi
}

install_dependencies() {
  if ! bun install --frozen-lockfile; then
    printf '%s\n' \
      'cloud-bootstrap: frozen install failed; check NPM_TOKEN and npm.ch5.me reachability.' >&2
    return 23
  fi
}

stage toolchain verify_toolchain
stage crypto-tools install_crypto_tools
stage registry-auth verify_registry_auth
stage dependencies install_dependencies
