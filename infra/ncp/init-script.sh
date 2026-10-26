#!/bin/bash
#
# NCP App Server Init Script
#
# 서버 이미지에 Docker 와 애플리케이션 이미지가 포함돼 있다는 전제로, 기동 시점에
# 환경변수를 주입하고 컨테이너를 띄운다. Auto Scaling 으로 새로 뜨는 서버도 같은 스크립트를 쓴다.
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
#   OBJECT_STORAGE_ENDPOINT      NCP Object Storage 엔드포인트
#   OBJECT_STORAGE_PUBLIC_ENDPOINT  브라우저가 공개 이미지를 받는 주소
: "${DATABASE_URL:?DATABASE_URL 을 지정할 것}"
: "${JWT_SECRET:?JWT_SECRET 을 지정할 것}"
: "${OBJECT_STORAGE_ACCESS_KEY:?OBJECT_STORAGE_ACCESS_KEY 를 지정할 것}"
: "${OBJECT_STORAGE_SECRET_KEY:?OBJECT_STORAGE_SECRET_KEY 를 지정할 것}"
: "${FRONTEND_URL:?FRONTEND_URL 을 지정할 것}"
: "${OBJECT_STORAGE_ENDPOINT:?OBJECT_STORAGE_ENDPOINT 를 지정할 것}"

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
  `# 관리자 API 접근 대역. 비우면 IP 제한을 적용하지 않는다` \
  -e ADMIN_ALLOWED_IP_CIDRS="${ADMIN_ALLOWED_IP_CIDRS:-}" \
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
