# Topic: Secret Encryption

> SOPS+age wrapper around encryption/decryption operations.

## Overview

Hush delegates all encryption and decryption to **SOPS** (Secrets OPerationS) using **age** as the encryption backend. The `core/sops.ts` module wraps `sops` CLI invocations for encrypt, decrypt, and edit operations.

## Encryption Flow

1. **Input**: Plaintext content is written to a private temp file in a `0o700` directory with `0o600` permissions.
2. **SOPS invocation**: `sops --input-type <format> --output-type <format> --encrypt --filename-override <output> <input>`
3. **Output**: Encrypted YAML/DOTENV content is written to the target `.encrypted` file.
4. **Cleanup**: Temp directory is removed in a `finally` block.

```
hush-cli/src/core/sops.ts:withPrivatePlaintextTempFile()
  → mkdtempSync + writeFileSync (0o600)
  → action(tempFile)  // encryptWithFormat
  → rmSync (finally)
```

## Decryption Flow

1. **Key resolution**: Age key is located via explicit SOPS env (`SOPS_AGE_KEY_FILE`, `SOPS_AGE_KEY_CMD`, `SOPS_AGE_KEY`) → per-project key path → standard SOPS keyring `~/.config/sops/age/keys.txt` → legacy compatibility path `~/.config/sops/age/key.txt`.
2. **SOPS invocation**: `sops --input-type <format> --output-type <format> --decrypt <file>`
3. **Output**: Plaintext content returned as string.

```
hush-cli/src/core/sops.ts:decryptWithFormat()
  → getAgeKeyFile() → getSopsEnv() → execSync(sops --decrypt)
```

## Key Resolution Priority

`getAgeKeyFile()` (in `hush-cli/src/core/sops.ts`, lines 26-50):

1. `SOPS_AGE_KEY_FILE` env var (highest priority)
2. `SOPS_AGE_KEY_CMD` / `SOPS_AGE_KEY` env vars (passed through untouched)
3. Per-project key at `~/.config/sops/age/keys/{project}.txt` if `keyIdentity` matches
4. Project-identifier-derived key (from `getProjectIdentifier(root)`)
5. Standard SOPS keyring at `~/.config/sops/age/keys.txt`
6. Legacy compatibility fallback at `~/.config/sops/age/key.txt`

## Encryption Formats

Two formats are supported:
- **dotenv** — `KEY=VALUE` format for environment variable files
- **yaml** — YAML format for manifest and structured config

Each has dedicated functions: `encrypt`/`decrypt` for dotenv, `encryptYaml`/`decryptYaml` for YAML.

## SOPS Configuration

`getSopsConfigFile()` looks for `.sops.yaml` in the project root. If found, it's passed via `--config` to SOPS commands. The `.sops.yaml` file contains:
- `creation_rules` with `age` (public key) and optionally `encrypted_regex` to control what SOPS encrypts.

## Preflight Budget (sharp edge)

Every SOPS call is gated by an `isSopsInstalled()` preflight that runs `sops --version` with a **2000ms** budget (`DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS`). Blowing it throws `SopsPreflightTimeoutError`; the budget exists to catch a real captive-portal hang (sops' GitHub update check stalling on filtered TLS) instead of wedging forever.

A heavily loaded machine can also just be slow to start sops — measured 17.8s wall at load average ~490, and 1475/1908/2193/2638/6256ms across five samples at load average 873 on chrislaptop (2026-07-25) **with the network version check already disabled**. So a blown 2000ms budget does not mean the network is wrong; it usually means the box is busy.

Because of that, a blown fast budget is **retried once** with `SOPS_PREFLIGHT_RETRY_TIMEOUT_MS` (20s default, overridable with `HUSH_SOPS_PREFLIGHT_RETRY_TIMEOUT_MS`, never lower than an explicitly raised fast budget). Only when *both* budgets blow does `SopsPreflightTimeoutError` throw, reporting `attempts: 2`. The fast path stays fast, a genuinely wedged sops still fails loud and bounded, and plain CPU starvation no longer masquerades as a captive portal. Override the fast budget itself with `HUSH_SOPS_PREFLIGHT_TIMEOUT_MS` (positive integer ms; invalid values throw rather than silently defaulting); `hush-cli/vitest.config.ts` sets it to 30000 for test runs only.

The preflight guards *every* encrypt/decrypt entry point, so it re-spawned `sops --version` once per decrypted file — two spawns measured for a `hush run` that aborted early at target selection. A **runnable** verdict is now memoized per process (`resetSopsPreflightCache()` clears it); a failure is never cached.

Sharp edges:
- A timed-out preflight makes *every* decrypt fail, which used to surface as unrelated failures elsewhere. `ensureEncryptedFixtureRepo()` in `hush-cli/tests/helpers/sops-test.ts` throws `FixtureNotDecryptedError` rather than writing still-encrypted content back over a tracked fixture.
- `loadMachineLocalOverrides()` wraps decrypt failures as `Invalid machine-local override file at <path>`. A `SopsPreflightTimeoutError` is now **re-thrown unwrapped**: relabeling an environment failure as file corruption sent `ch5-managed-runtime ensure ch5-devtools` chasing a nonexistent bad file for hours on 2026-07-25. Any new wrapper on a sops call must preserve typed environment failures the same way.

## Machine Keyring Leaks Into Tests (sharp edge)

`SOPS_AGE_KEY_FILE` is **additive, not exclusive**: sops loads that identity *plus* the machine's default keyring (`~/Library/Application Support/sops/age/keys.txt` on macOS, `$XDG_CONFIG_HOME/sops/age/keys.txt` elsewhere). A test whose premise is "this recipient is foreign, so decryption must fail" therefore passed for the wrong reason on any box holding that recipient's private key, and meant something different in CI.

`hush-cli/tests/setup/isolate-machine-keyring.ts` (a vitest `setupFiles` entry) repoints `HOME` at a throwaway directory for every test process and deletes `XDG_CONFIG_HOME` plus the three `SOPS_AGE_KEY*` variables, so neither the real keyring, the real `~/.hush` store, nor an identity exported in the developer's shell is reachable. `XDG_CONFIG_HOME` is deleted rather than repointed: an absolute value outranks the per-test `HOME` overrides that Linux key resolution reads through it, which would make keyring-path tests share one directory on CI while still passing on macOS.

Use `generateThrowawayAgeRecipient()` from `tests/helpers/sops-test.ts` for foreign recipients rather than hardcoding one. Two tests in `tests/core/sops.test.ts` keep the isolation honest: the hardcoded `MACHINE_KEYRING_CANARY_RECIPIENT` asserts that a file encrypted to a real developer's key does *not* decrypt, and a positive control writes a throwaway key into the sandbox's default keyring and asserts it *does* — that second one fails on any machine if `setupFiles` is dropped, even after the canary key is rotated away.

## Error Handling

Decryption errors check for `No identity matched` in stderr and now report the selected key identity/source plus every attempted key path so repo bootstrap and local key placement are easier to debug. All SOPS failures include stderr output in the error message.

### In-memory content encryption

`encryptYamlContent()` allows encrypting a YAML string directly without a source file, using `withPrivatePlaintextTempFile()` internally.

### File edit

`sops --encrypt` is called with `stdio: inherit` to allow SOPS's interactive editor. The file is edited in-place by SOPS.

## Source Attribution

> Sources: `hush-cli/src/core/sops.ts` (full file, lines 1-256) — `decryptWithFormat`, `encryptWithFormat`, `withPrivatePlaintextTempFile`, `getAgeKeyFile`, `getSopsEnv`, `setKey`, `edit`
