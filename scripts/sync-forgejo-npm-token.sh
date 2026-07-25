#!/usr/bin/env bash
# Re-point the Forgejo Actions NPM_TOKEN secret at the value Hush holds.
#
# The release job publishes to CH5 Verdaccio using the org Actions secret
# NPM_TOKEN. Hush is the source of truth for that credential, and nothing keeps
# the two in sync: on 2026-07-25 the org secret had drifted to a value Verdaccio
# rejected, so `release` failed at its auth preflight ("NPM_TOKEN was rejected by
# CH5 Verdaccio") on every push while the Hush value authenticated fine. The
# recovery took longer to rediscover than to apply, so it lives here.
#
# Usage:  scripts/sync-forgejo-npm-token.sh [--check]
#   --check  verify the Hush token works against Verdaccio; change nothing.
#
# Requires: hush on PATH, a git credential for git.ch5.me with org admin rights.
# Never prints the token.
set -euo pipefail

FORGEJO_HOST="git.ch5.me"
REGISTRY="https://npm.ch5.me/"
ORG="ch5"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# A cold `sops --version` on a loaded box can blow the default preflight budget
# and make this look like a missing secret. Give it room.
export HUSH_SOPS_PREFLIGHT_TIMEOUT_MS="${HUSH_SOPS_PREFLIGHT_TIMEOUT_MS:-60000}"

# Verify the Hush value is the one Verdaccio accepts before pushing it anywhere.
# Exit status only -- the identity is printed, the token never is.
echo "Checking the Hush NPM_TOKEN against ${REGISTRY} ..."
WHOAMI=$(hush run --root "$HOME/.hush" --target root -- sh -c '
  set -e
  D=$(mktemp -d)
  trap "rm -rf $D" EXIT
  printf "//npm.ch5.me/:_authToken=%s\n@chriscode:registry=https://npm.ch5.me/\nregistry=https://npm.ch5.me/\n" "$NPM_TOKEN" > "$D/.npmrc"
  HOME=$D npm whoami --registry=https://npm.ch5.me/ 2>/dev/null
')

if [ -z "$WHOAMI" ]; then
  echo "FAIL: the NPM_TOKEN in Hush is itself rejected by ${REGISTRY}." >&2
  echo "Recover the publish credential first (skill: ch5me-npm-packages)." >&2
  exit 1
fi
echo "OK: Hush NPM_TOKEN authenticates as '${WHOAMI}'."

if [ "$CHECK_ONLY" = "1" ]; then
  echo "--check given; leaving the Forgejo secret untouched."
  exit 0
fi

# Forgejo admin credential comes from the git credential helper, never a literal.
CRED=$(printf 'protocol=https\nhost=%s\n\n' "$FORGEJO_HOST" | git credential fill)
FJ_USER=$(printf '%s\n' "$CRED" | sed -n 's/^username=//p')
FJ_PASS=$(printf '%s\n' "$CRED" | sed -n 's/^password=//p')
if [ -z "$FJ_USER" ] || [ -z "$FJ_PASS" ]; then
  echo "FAIL: no git credential for ${FORGEJO_HOST}." >&2
  exit 1
fi

echo "Writing org '${ORG}' Actions secret NPM_TOKEN from Hush ..."
CODE=$(hush run --root "$HOME/.hush" --target root -- \
  python3 -c '
import base64, json, os, urllib.request, urllib.error
body = json.dumps({"data": os.environ["NPM_TOKEN"]}).encode()
req = urllib.request.Request(
    "https://%s/api/v1/orgs/%s/actions/secrets/NPM_TOKEN" % (os.environ["FORGEJO_HOST"], os.environ["ORG"]),
    data=body, method="PUT", headers={"Content-Type": "application/json"})
auth = base64.b64encode(("%s:%s" % (os.environ["FJ_USER"], os.environ["FJ_PASS"])).encode()).decode()
req.add_header("Authorization", "Basic " + auth)
try:
    print(urllib.request.urlopen(req).status)
except urllib.error.HTTPError as e:
    print(e.code)
' ) FORGEJO_HOST="$FORGEJO_HOST" ORG="$ORG" FJ_USER="$FJ_USER" FJ_PASS="$FJ_PASS"

case "$CODE" in
  201|204) echo "OK: org secret NPM_TOKEN updated (HTTP $CODE)." ;;
  403) echo "FAIL: HTTP 403 -- '${FJ_USER}' lacks org-admin rights on '${ORG}'." >&2; exit 1 ;;
  *)   echo "FAIL: unexpected HTTP $CODE writing the org secret." >&2; exit 1 ;;
esac

echo
echo "The release job only runs on a push to main (event_name == 'push'),"
echo "so a workflow_dispatch will NOT retry the publish. Land a commit."
