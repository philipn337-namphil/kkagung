#!/bin/bash
#
# NCP App Server Init Script
#
# 서버 이미지에 Docker 가 설치돼 있다는 전제로, 기동 시점에 Container Registry 에서
# 애플리케이션 이미지를 받아 환경변수를 주입하고 컨테이너를 띄운다. Auto Scaling 으로
# 새로 뜨는 서버도 같은 스크립트를 쓰므로, 증설된 서버가 최신 이미지를 받는다.
#
# 레지스트리는 공인 주소다. VPC 에서는 Private Endpoint 를 쓸 수 없으므로(Classic 전용),
# 앱 서브넷에 NAT Gateway 경로가 있어야 이 스크립트가 동작한다.
#
# 비밀값은 이 파일에 적지 않는다. 아래 "주입받는 값"을 콘솔의 서버 환경변수나
# 별도 비밀 관리 수단으로 넘기고, 이 스크립트는 그 값을 읽기만 한다.
# 이미지·저장소·로그 어디에도 값이 남지 않게 한다.
#
set -euo pipefail

APP_IMAGE="${APP_IMAGE:?APP_IMAGE 를 지정할 것}"
CONTAINER_NAME="kkagung-api"

# ── 주입받는 값 ───────────────────────────────────────────────
#   DATABASE_URL                 Cloud DB 접속 문자열 (비밀번호 포함)
#   JWT_SECRET                   32바이트 이상 무작위
#   OBJECT_STORAGE_ACCESS_KEY    NCP 인증키
#   OBJECT_STORAGE_SECRET_KEY    NCP 인증키
#   FRONTEND_URL                 서비스 도메인 (HTTPS)
#   NCP_ACCESS_KEY               Container Registry 로그인. Object Storage 와 같은 NCP API 인증키
#   NCP_SECRET_KEY               위 인증키의 시크릿
#   OBJECT_STORAGE_ENDPOINT      NCP Object Storage 엔드포인트
#   OBJECT_STORAGE_PUBLIC_ENDPOINT  브라우저가 공개 이미지를 받는 주소
: "${DATABASE_URL:?DATABASE_URL 을 지정할 것}"
: "${JWT_SECRET:?JWT_SECRET 을 지정할 것}"
: "${OBJECT_STORAGE_ACCESS_KEY:?OBJECT_STORAGE_ACCESS_KEY 를 지정할 것}"
: "${OBJECT_STORAGE_SECRET_KEY:?OBJECT_STORAGE_SECRET_KEY 를 지정할 것}"
: "${FRONTEND_URL:?FRONTEND_URL 을 지정할 것}"
: "${OBJECT_STORAGE_ENDPOINT:?OBJECT_STORAGE_ENDPOINT 를 지정할 것}"
: "${NCP_ACCESS_KEY:?NCP_ACCESS_KEY 를 지정할 것}"
: "${NCP_SECRET_KEY:?NCP_SECRET_KEY 를 지정할 것}"

# 레지스트리 주소는 이미지 이름에서 꺼낸다. 따로 받으면 둘이 어긋난 채로 기동할 수 있다.
REGISTRY_HOST="${APP_IMAGE%%/*}"
case "${REGISTRY_HOST}" in
  *.*) ;;
  *)
    echo "APP_IMAGE 는 레지스트리 주소를 포함한 전체 이름이어야 한다." >&2
    echo "  예) <레지스트리>.kr.ncr.ntruss.com/kkagung-api:<태그>" >&2
    exit 1
    ;;
esac

# 비밀번호를 인자로 넘기면 ps 출력에 그대로 보인다. 표준입력으로 넘긴다.
printf '%s' "${NCP_SECRET_KEY}" | docker login "${REGISTRY_HOST}" -u "${NCP_ACCESS_KEY}" --password-stdin

# docker login 은 자격증명을 ~/.docker/config.json 에 남긴다. 인스턴스에 두지 않는다.
# 중간에 실패해도 지워지도록 trap 으로 건다.
trap 'docker logout "${REGISTRY_HOST}" >/dev/null 2>&1 || true' EXIT

# 받아오는 것이 먼저다. 돌던 컨테이너를 먼저 지우면 pull 이 실패했을 때
# 되돌릴 것도 없이 서비스만 내려간다.
docker pull "${APP_IMAGE}"

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

docker run -d --name "${CONTAINER_NAME}" --restart unless-stopped -p 8080:8080 \
  -e NODE_ENV=production \
  -e APP_ENV=production \
  -e APP_PORT=8080 \
  -e DATABASE_URL="${DATABASE_URL}" \
  -e JWT_SECRET="${JWT_SECRET}" \
  -e FRONTEND_URL="${FRONTEND_URL}" \
  `# 운영 TTL 은 900s 가 기본이라 생략해도 되지만 의도를 드러내 둔다(D-03)` \
  -e JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-900s}" \
  `# 비우면 모든 사용자가 LB 주소 하나로 집계되어 함께 429 를 맞는다` \
  -e TRUST_PROXY="${TRUST_PROXY:-1}" \
  `# 마이그레이션은 배포 단계에서 한 번만 돌린다. 여러 대가 동시에 뜨므로 여기서는 끈다` \
  -e RUN_MIGRATIONS_ON_START=false \
  -e OBJECT_STORAGE_ENDPOINT="${OBJECT_STORAGE_ENDPOINT}" \
  -e OBJECT_STORAGE_PUBLIC_ENDPOINT="${OBJECT_STORAGE_PUBLIC_ENDPOINT:-}" \
  -e OBJECT_STORAGE_BUCKET_PUBLIC="${OBJECT_STORAGE_BUCKET_PUBLIC:-kkagung-images-public}" \
  -e OBJECT_STORAGE_BUCKET_PRIVATE="${OBJECT_STORAGE_BUCKET_PRIVATE:-kkagung-images-private}" \
  -e OBJECT_STORAGE_ACCESS_KEY="${OBJECT_STORAGE_ACCESS_KEY}" \
  -e OBJECT_STORAGE_SECRET_KEY="${OBJECT_STORAGE_SECRET_KEY}" \
  -e OBJECT_STORAGE_REGION="${OBJECT_STORAGE_REGION:-kr-standard}" \
  -e OBJECT_STORAGE_FORCE_PATH_STYLE="${OBJECT_STORAGE_FORCE_PATH_STYLE:-true}" \
  `# 관리자 API 접근 대역. 운영에서 비우면 lib/admin.ts 가 관리자 요청을 전부 403 으로 막는다.` \
  -e ADMIN_ALLOWED_IP_CIDRS="${ADMIN_ALLOWED_IP_CIDRS:?set ADMIN_ALLOWED_IP_CIDRS - empty blocks every admin request in production}" \
  "${APP_IMAGE}"

# LB 헬스체크가 붙기 전에 애플리케이션이 뜰 때까지 기다린다.
# /health 는 DB 연결까지 확인하므로, 여기서 실패하면 LB 에 넣어도 의미가 없다.
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:8080/health"; then
    echo "application is ready"
    exit 0
  fi
  sleep 2
done

echo "application did not become healthy" >&2
docker logs --tail 50 "${CONTAINER_NAME}" >&2
exit 1
