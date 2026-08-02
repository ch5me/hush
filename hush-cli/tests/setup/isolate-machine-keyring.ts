import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

/**
 * sops loads age identities from SOPS_AGE_KEY_FILE *in addition to* the machine's
 * default keyring — `~/Library/Application Support/sops/age/keys.txt` on macOS,
 * `$XDG_CONFIG_HOME/sops/age/keys.txt` elsewhere — so pointing SOPS_AGE_KEY_FILE
 * at the test key does not stop a developer's real keys from being used.
 *
 * That makes any "this recipient is foreign, so decryption must fail" test a
 * silent no-op on a box that happens to hold that recipient's private key: it
 * passes for the wrong reason locally and means something different in CI.
 * Repointing HOME at a throwaway directory for the whole run makes the real
 * keyring unreachable, so every test sees the same keyring: only the identities
 * it created itself.
 *
 * hush's own key resolution (`~/.config/sops/age/keys/{project}.txt`, the global
 * `~/.hush` store) reads HOME through `os.homedir()`, so it follows the sandbox
 * too — tests can no longer touch the developer's real hush state either.
 */
const sandboxHome = mkdtempSync(join(tmpdir(), "hush-test-home-"));

process.env.HOME = sandboxHome;

// XDG_CONFIG_HOME is deleted rather than repointed at the sandbox: an absolute
// value would outrank the per-test `process.env.HOME` overrides that Linux key
// resolution reads through it, so tests asserting keyring paths under their own
// temp HOME would silently share one directory on CI while passing on macOS.
// Deleting it leaves both sops and hush resolving `$HOME/.config`, which is the
// sandbox, and keeps the two platforms behaving identically.
delete process.env.XDG_CONFIG_HOME;

// Same leak by another route: a developer who exports any of these in their
// shell would hand every test an identity it never asked for. Tests that need
// one set it themselves (`ensureTestSopsEnv()`).
delete process.env.SOPS_AGE_KEY;
delete process.env.SOPS_AGE_KEY_CMD;
delete process.env.SOPS_AGE_KEY_FILE;

afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true });
});
