# Topic: Vendor Catalog <!-- oc:id=sec_aa -->

> Reference catalog for third-party vendor integrations supported by Hush. Documents secret key names, typical Hush file layouts, and configuration patterns for each vendor.

## Overview <!-- oc:id=sec_ab -->

Each vendor entry documents:
- **Vendor type** — OAuth App, GitHub App, API key, etc.
- **Typical secrets** — Key names and purposes
- **Hush file layout** — Recommended file path structure for the vendor's secrets
- **Target pattern** — How to wire the vendor's secrets into a target bundle

The catalog lives in two places:
- `.llm/wiki/topics/vendor-catalog.md` — Agent-facing reference (this file)
- `docs/src/content/docs/reference/vendor-catalog.mdx` — User-facing documentation

## Adding a New Vendor <!-- oc:id=sec_ac -->

To document a new vendor, add a new section below following this structure:

```markdown
## <Vendor Name>

**Type:** <OAuth App | GitHub App | API Key | OAuth + GitHub App | etc.>

<Two-sentence description of the vendor and why you would use it.>

### Typical Secrets

| Key | Description | Sensitive |
|-----|-------------|-----------|
| `VENDOR_KEY` | One-line description | yes |

### Recommended File Layout

```
env/
  vendor/
    <vendor>-secrets.encrypted   # Holds all vendor secrets
```

### Target Bundle Example

```yaml
targets:
  <vendor>-runtime:
    bundle: <vendor>-bundle
    format: dotenv
bundles:
  <vendor>-bundle:
    files:
      - path: env/vendor/<vendor>-secrets
```

### Notes

- Any special setup steps or ordering requirements
- Link to official vendor docs
```

---

## GitHub OAuth App

**Type:** OAuth 2.0 Application

A GitHub OAuth App authenticates users via the OAuth 2.0 flow. Use this when your app needs to act on behalf of a user (e.g., reading their repositories, posting commits).

### Typical Secrets

| Key | Description | Sensitive |
|-----|-------------|-----------|
| `GITHUB_CLIENT_ID` | OAuth app client ID from GitHub App settings | no |
| `GITHUB_CLIENT_SECRET` | OAuth app client secret from GitHub App settings | yes |

### Recommended File Layout

```
env/
  integrations/
    github-oauth.encrypted    # Holds GitHub OAuth credentials
```

### Setup Steps

1. Create a GitHub OAuth App at [github.com/settings/applications/new](https://github.com/settings/applications/new)
2. Set the homepage URL and authorization callback URL
3. Note the **Client ID** (not sensitive) and generate a **Client Secret**
4. Store `GITHUB_CLIENT_ID` in the shared file (non-sensitive, can be committed in some setups)
5. Store `GITHUB_CLIENT_SECRET` in the secrets file (always sensitive)
6. Implement the OAuth flow using the client credentials to obtain user access tokens

### Target Bundle Example

```yaml
# .hush/manifest.encrypted
bundles:
  github-oauth-bundle:
    files:
      - path: env/integrations/github-oauth
targets:
  github-oauth-dev:
    bundle: github-oauth-bundle
    format: dotenv
```

### Notes

- The OAuth flow requires redirect URI match — verify it matches exactly in GitHub settings
- Access tokens expire; implement token refresh if storing tokens
- GitHub OAuth Apps are tied to a user account, not an organization
- For org-owned apps, consider GitHub Apps instead
- [GitHub OAuth App documentation](https://docs.github.com/en/apps/oauth-apps)

---

## GitHub App <!-- oc:id=sec_ad -->

**Type:** GitHub App + OAuth 2.0

A GitHub App is an entity that can be installed on organizations or user accounts. GitHub Apps can also use OAuth 2.0 to act on behalf of users. Use this when you need bot-style access, webhook receivers, or org-scoped permissions.

### Typical Secrets <!-- oc:id=sec_ae -->

| Key | Description | Sensitive |
|-----|-------------|-----------|
| `GITHUB_APP_ID` | GitHub App's numeric ID (found in app settings) | no |
| `GITHUB_APP_PRIVATE_KEY` | Private key (.pem) for signing JWTs | yes |
| `GITHUB_APP_CLIENT_ID` | OAuth app client ID for user-to-server requests | no |
| `GITHUB_APP_CLIENT_SECRET` | OAuth app client secret for user-to-server requests | yes |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for validating webhook payloads | yes |

### Recommended File Layout <!-- oc:id=sec_af -->

```
env/
  integrations/
    github-app.encrypted     # Holds GitHub App credentials + webhook secret
```

### Setup Steps <!-- oc:id=sec_ag -->

1. Create a GitHub App at [github.com/settings/apps/new](https://github.com/settings/apps/new) <!-- oc:id=item_aa -->
1. Set the app name, homepage URL, and webhook URL <!-- oc:id=item_ab -->
1. Generate a **private key** (downloads as `.pem`) — store this in Hush <!-- oc:id=item_ac -->
1. Note the **App ID** from the app settings page <!-- oc:id=item_ad -->
1. From the OAuth settings within the GitHub App, note the **Client ID** and generate a **Client Secret** <!-- oc:id=item_ae -->
1. Set a **webhook secret** and store it in Hush <!-- oc:id=item_af -->
1. Install the app on your organization or user account <!-- oc:id=item_ag -->
1. Store all values in Hush using `hush set` <!-- oc:id=item_ah -->

### Obtaining Installation Access Token <!-- oc:id=sec_ah -->

GitHub Apps use JWT authentication for API access:

```typescript
// Pseudocode for GitHub App JWT auth
const jwt = signJWT({
  iss: GITHUB_APP_ID,
  exp: Math.floor(Date.now() / 1000) + 600, // 10 min max
}, GITHUB_APP_PRIVATE_KEY, 'RS256');

const installationResponse = await fetch(
  `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
  { headers: { Authorization: `Bearer ${jwt}` } }
);
const { token } = await installationResponse.json();
// Use token for API calls
```

### OAuth for User-to-Server Requests <!-- oc:id=sec_ai -->

GitHub Apps can also use OAuth 2.0 to act on behalf of users:

```typescript
// OAuth flow: redirect to GitHub, exchange code for token
const oauthTokenResponse = await fetch('https://github.com/login/oauth/access_token', {
  method: 'POST',
  headers: { Accept: 'application/json' },
  body: JSON.stringify({
    client_id: GITHUB_APP_CLIENT_ID,
    client_secret: GITHUB_APP_CLIENT_SECRET,
    code: oauthCode,
  }),
});
const { access_token } = await oauthTokenResponse.json();
```

### Webhook Payload Validation <!-- oc:id=sec_aj -->

Validate incoming webhook payloads using the shared secret:

```typescript
import { createHmac } from 'crypto';

function validateWebhook(payload: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return `sha256=${expected}` === signature;
}
```

### Target Bundle Example <!-- oc:id=sec_ak -->

```yaml
# .hush/manifest.encrypted
bundles:
  github-app-bundle:
    files:
      - path: env/integrations/github-app
targets:
  github-app-dev:
    bundle: github-app-bundle
    format: dotenv
```

### Notes <!-- oc:id=sec_al -->

- Private keys cannot be retrieved after generation — download and store immediately
- GitHub App permissions are defined at the org/repo level during installation
- App tokens expire after 1 hour; refresh using the installation token flow
- Webhook secrets are optional but recommended for security
- [GitHub App documentation](https://docs.github.com/en/apps/creating-github-apps)
- [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [GitHub App OAuth](https://docs.github.com/en/apps/creating-github-apps/building-oauth-apps/authorizing-oauth-apps)

---

## Adding GitHub OAuth + Apps to a Project

### Step 1: Bootstrap the vendor file

```bash
hush file add env/integrations/github-app --roles owner,ci
```

### Step 2: Add secrets

```bash
hush set GITHUB_APP_ID --from-value "123456"
hush set GITHUB_APP_PRIVATE_KEY --from-value "$(cat /path/to/app.2024-01-15.private-key.pem)"
hush set GITHUB_APP_CLIENT_ID --from-value "Iv1.abc123..."
hush set GITHUB_APP_CLIENT_SECRET --from-value "ov2.xxx..."
hush set GITHUB_WEBHOOK_SECRET --from-value "your-webhook-secret"
```

### Step 3: Wire to a bundle and target

```bash
hush bundle add github-app-bundle --files env/integrations/github-app
hush target add github-app-runtime --bundle github-app-bundle --format dotenv
```

### Step 4: Verify

```bash
hush verify-target github-app-runtime --require GITHUB_APP_ID
hush resolve github-app-runtime --json
```

> Sources: `docs/src/content/docs/reference/vendor-catalog.mdx`; [GitHub OAuth Apps](https://docs.github.com/en/apps/oauth-apps); [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps); `hush-cli/src/v3/domain.ts`