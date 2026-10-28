#!/bin/bash
#
# NCP App Server Init Script
#
# ASCII ONLY. The NCP console rejects an Init Script that contains non-ASCII
# characters, so this file stays in English even though the rest of the
# repository is commented in Korean. Keep it that way: a translated copy made
# at registration time drifts from this one. See docs/07 for the Korean notes.
#
# The server image is expected to have Docker installed. On boot this script
# pulls the application image from Container Registry and starts it. Auto
# Scaling uses the same script, so a scaled-out server gets the same image.
#
# The registry is a public address. A VPC cannot use the private endpoint
# (Classic only), so the app subnet needs a NAT Gateway route for this to work,
# and the app ACG needs its outbound opened.
#
# ---- Where the values come from --------------------------------------------
# The NCP VPC server creation screen has no field for environment variables.
# The only thing you can attach is an Init Script whose body is stored in the
# console. There is no way to pass values from outside, so filling the block
# below is the only channel.
#
# The copy in this repository is a template with empty values. Fill the values
# only in the console copy and never commit them. Anyone with console access
# can read them in plain text; that is accepted for this deployment. The
# alternatives that were considered are written up in docs/07.
#
set -euo pipefail

CONTAINER_NAME="kkagung-api"
FRONTEND_CONTAINER="kkagung-frontend"

# ---- Fill these in the console ---------------------------------------------
APP_IMAGE=""                   # <registry>.kr.ncr.ntruss.com/kkagung-api:<commit>
DATABASE_URL=""                # mysql://kkagung_app:<password>@<cloud db host>:3306/kkagung
                               #   percent-encode the password: @ is %40, # is %23, / is %2F
JWT_SECRET=""                  # 32+ random bytes
FRONTEND_URL=""                # service address the browser sees, scheme included
OBJECT_STORAGE_ENDPOINT=""     # https://kr.object.ncloudstorage.com
OBJECT_STORAGE_ACCESS_KEY=""   # NCP API key
OBJECT_STORAGE_SECRET_KEY=""   # secret of the same key
NCP_ACCESS_KEY=""              # Container Registry login. Same NCP API key as above
NCP_SECRET_KEY=""              # secret of the same key
ADMIN_ALLOWED_IP_CIDRS=""      # admin source ranges. Empty means every admin call is 403

# ---- Optional. Empty falls back to the value in parentheses -----------------
OBJECT_STORAGE_PUBLIC_ENDPOINT=""  # (same as the endpoint above) address the browser fetches public images from
OBJECT_STORAGE_BUCKET_PUBLIC=""    # (kkagung-images-public)
OBJECT_STORAGE_BUCKET_PRIVATE=""   # (kkagung-images-private)
OBJECT_STORAGE_REGION=""           # (kr-standard)
OBJECT_STORAGE_FORCE_PATH_STYLE="" # (true)
JWT_EXPIRES_IN=""                  # (900s) production default, so leaving it empty is fine (D-03)
TRUST_PROXY=""                     # (1) empty means every user is counted as the LB address and they all hit 429 together

# ---- Frontend. Fill only when it runs on this same server -------------------
# Used when the LB splits by path: /api/* to 8080, everything else to 5173.
# Leaving it empty starts the API container only.
FRONTEND_IMAGE=""                  # <registry>.kr.ncr.ntruss.com/kkagung-web:<commit>
API_BASE_URL=""                    # (/) address the browser calls the API on.
                                   #     With both behind one LB, / keeps it same-origin.

# Stop here if something was not filled in. Better than coming up misconfigured.
: "${APP_IMAGE:?fill APP_IMAGE}"
: "${DATABASE_URL:?fill DATABASE_URL}"
: "${JWT_SECRET:?fill JWT_SECRET}"
: "${FRONTEND_URL:?fill FRONTEND_URL}"
: "${OBJECT_STORAGE_ENDPOINT:?fill OBJECT_STORAGE_ENDPOINT}"
: "${OBJECT_STORAGE_ACCESS_KEY:?fill OBJECT_STORAGE_ACCESS_KEY}"
: "${OBJECT_STORAGE_SECRET_KEY:?fill OBJECT_STORAGE_SECRET_KEY}"
: "${NCP_ACCESS_KEY:?fill NCP_ACCESS_KEY}"
: "${NCP_SECRET_KEY:?fill NCP_SECRET_KEY}"
# Empty makes lib/admin.ts reject every admin request with 403, while /health
# stays green, so the mistake surfaces late.
: "${ADMIN_ALLOWED_IP_CIDRS:?fill ADMIN_ALLOWED_IP_CIDRS}"

# Take the registry host from the image name. Passing it separately lets the
# two disagree and the server boots against the wrong registry.
REGISTRY_HOST="${APP_IMAGE%%/*}"
case "${REGISTRY_HOST}" in
  *.*) ;;
  *)
    echo "APP_IMAGE must include the registry host." >&2
    echo "  example: <registry>.kr.ncr.ntruss.com/kkagung-api:<tag>" >&2
    exit 1
    ;;
esac

# Passing the password as an argument puts it in ps output. Send it on stdin.
printf '%s' "${NCP_SECRET_KEY}" | docker login "${REGISTRY_HOST}" -u "${NCP_ACCESS_KEY}" --password-stdin

# docker login leaves credentials in ~/.docker/config.json. Do not keep them on
# the instance. The trap clears them even when a later step fails.
trap 'docker logout "${REGISTRY_HOST}" >/dev/null 2>&1 || true' EXIT

# Pull first. Removing the running container before the pull means a registry
# failure takes the service down with nothing to roll back to.
docker pull "${APP_IMAGE}"
[ -n "${FRONTEND_IMAGE}" ] && docker pull "${FRONTEND_IMAGE}"

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

docker run -d --name "${CONTAINER_NAME}" --restart unless-stopped -p 8080:8080 \
  -e NODE_ENV=production \
  -e APP_ENV=production \
  -e APP_PORT=8080 \
  -e DATABASE_URL="${DATABASE_URL}" \
  -e JWT_SECRET="${JWT_SECRET}" \
  -e FRONTEND_URL="${FRONTEND_URL}" \
  -e JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-900s}" \
  -e TRUST_PROXY="${TRUST_PROXY:-1}" \
  `# Migrations run once from the deploy step. Several servers start at once, so keep this off here.` \
  -e RUN_MIGRATIONS_ON_START=false \
  -e OBJECT_STORAGE_ENDPOINT="${OBJECT_STORAGE_ENDPOINT}" \
  -e OBJECT_STORAGE_PUBLIC_ENDPOINT="${OBJECT_STORAGE_PUBLIC_ENDPOINT:-${OBJECT_STORAGE_ENDPOINT}}" \
  -e OBJECT_STORAGE_BUCKET_PUBLIC="${OBJECT_STORAGE_BUCKET_PUBLIC:-kkagung-images-public}" \
  -e OBJECT_STORAGE_BUCKET_PRIVATE="${OBJECT_STORAGE_BUCKET_PRIVATE:-kkagung-images-private}" \
  -e OBJECT_STORAGE_ACCESS_KEY="${OBJECT_STORAGE_ACCESS_KEY}" \
  -e OBJECT_STORAGE_SECRET_KEY="${OBJECT_STORAGE_SECRET_KEY}" \
  -e OBJECT_STORAGE_REGION="${OBJECT_STORAGE_REGION:-kr-standard}" \
  -e OBJECT_STORAGE_FORCE_PATH_STYLE="${OBJECT_STORAGE_FORCE_PATH_STYLE:-true}" \
  -e ADMIN_ALLOWED_IP_CIDRS="${ADMIN_ALLOWED_IP_CIDRS}" \
  "${APP_IMAGE}"

# Start the frontend only when it shares this server. The LB routes by path.
# API_BASE_URL of / makes the browser call /api/v1 on the same origin, so CORS
# never comes into play.
if [ -n "${FRONTEND_IMAGE}" ]; then
  docker rm -f "${FRONTEND_CONTAINER}" >/dev/null 2>&1 || true
  docker run -d --name "${FRONTEND_CONTAINER}" --restart unless-stopped -p 5173:5173 -e API_BASE_URL="${API_BASE_URL:-/}" "${FRONTEND_IMAGE}"
fi

# Wait until it is up before the LB health check arrives. /health also checks
# the database connection, so failing here means the LB would gain nothing.
wait_for() {
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "$1"; then return 0; fi
    sleep 2
  done
  echo "$2 did not become healthy" >&2
  docker logs --tail 50 "$3" >&2
  return 1
}

wait_for "http://127.0.0.1:8080/health" "api" "${CONTAINER_NAME}" || exit 1
if [ -n "${FRONTEND_IMAGE}" ]; then
  wait_for "http://127.0.0.1:5173/" "frontend" "${FRONTEND_CONTAINER}" || exit 1
fi

echo "application is ready"
