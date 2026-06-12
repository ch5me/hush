# Security Policy

## Supported Versions

Only the latest 7.x release is actively maintained and receives security fixes.

| Version | Supported |
|---------|-----------|
| 7.x (latest) | yes |
| < 7.x | no |

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Use one of these channels:

1. **GitHub private vulnerability reporting** — preferred. Go to [https://github.com/ch5me/hush/security/advisories/new](https://github.com/ch5me/hush/security/advisories/new) and submit a private advisory.
2. **Email** — hassoncs@gmail.com. Include "SECURITY" in the subject line.

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions (if known)
- Any suggested fix (optional)

### Response expectations

This is a single-maintainer open source project. Best-effort response is the honest commitment — expect acknowledgement within a few business days, and a fix or mitigation plan within a reasonable timeframe depending on severity. There is no formal SLA.

## Scope

**In scope:**
- Vulnerabilities in the `@chriscode/hush` CLI
- Issues where Hush leaks plaintext secrets through unintended paths
- ACL bypass or identity confusion bugs

**Out of scope:**
- Vulnerabilities in upstream dependencies (sops, age) — report those to their respective projects
- Misconfigured user repositories (e.g. committing `.hush.local` with private keys)
- Issues that require an attacker to already have full access to the host machine

## Cryptographic note

Hush delegates all cryptographic operations to [sops](https://github.com/getsops/sops) and [age](https://github.com/FiloSottile/age). No home-rolled crypto is used. **Hush has not yet been externally audited.** Use it with that in mind, and review the [threat model](/guides/threat-model/) for an honest assessment of what Hush does and does not protect against.
