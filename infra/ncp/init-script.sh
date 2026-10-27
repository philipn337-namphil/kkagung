#!/bin/bash
#
# NCP App Server Init Script
#
# 서버 이미지에 Docker 가 설치돼 있다는 전제로, 기동 시점에 Container Registry 에서
# 애플리케이션 이미지를 받아 컨테이너를 띄운다. Auto Scaling 으로 새로 뜨는 서버도
# 같은 스크립트를 쓰므로, 증설된 서버가 최신 이미지를 받는다.
#
# 레지스트리는 공인 주소다. VPC 에서는 Private Endpoint 를 쓸 수 없으므로(Classic 전용),
# 앱 서브넷에 NAT Gateway 경로가 있어야 이 스크립트가 동작한다.
#
# ── 값을 어디에 넣나 ────────────────────────────────────────
# NCP VPC 서버 생성 화면에는 환경변수를 넣는 칸이 없다. 고를 수 있는 것은 미리
# 콘솔에 저장해 둔 Init Script 하나뿐이다. 값을 스크립트 바깥에서 넘길 방법이
# 없으므로, 아래 블록에 직접 적는 것이 유일한 통로다.
#
# 저장소의 이 파일은 값이 빈 템플릿으로 둔다. 값을 채운 사본은 콘솔에만 두고
# 커밋하지 않는다. 콘솔 접근 권한이 있는 사람에게 평문으로 보이는 것은 감수한다.
# 검토한 대안과 그 한계는 docs/07_NCP_배포_절차.md 의 "시크릿을 두는 곳" 에 있다.
#
set -euo pipefail

CONTAINER_NAME="kkagung-api"

# ── 콘솔에 등록할 때 큰따옴표 안을 채운다 ───────────────────
APP_IMAGE=""                   # <레지스트리>.kr.ncr.ntruss.com/kkagung-api:<커밋 해시>
DATABASE_URL=""                # mysql://kkagung_app:<비밀번호>@<Cloud DB 주소>:3306/kkagung
JWT_SECRET=""                  # 32바이트 이상 무작위
FRONTEND_URL=""                # 서비스 도메인 (HTTPS)
OBJECT_STORAGE_ENDPOINT=""     # https://kr.object.ncloudstorage.com
OBJECT_STORAGE_ACCESS_KEY=""   # NCP API 인증키
OBJECT_STORAGE_SECRET_KEY=""   # 위 인증키의 시크릿
NCP_ACCESS_KEY=""              # Container Registry 로그인. 위와 같은 인증키를 쓴다
NCP_SECRET_KEY=""              # 위 인증키의 시크릿
ADMIN_ALLOWED_IP_CIDRS=""      # 관리자 접속 대역. 비우면 관리자 API 가 전부 403 이다

# ── 선택값. 비워 두면 괄호 안 값을 쓴다 ─────────────────────
OBJECT_STORAGE_PUBLIC_ENDPOINT=""  # (위 엔드포인트와 같은 값) 브라우저가 공개 이미지를 받는 주소
OBJECT_STORAGE_BUCKET_PUBLIC=""    # (kkagung-images-public)
OBJECT_STORAGE_BUCKET_PRIVATE=""   # (kkagung-images-private)
OBJECT_STORAGE_REGION=""           # (kr-standard)
OBJECT_STORAGE_FORCE_PATH_STYLE="" # (true)
JWT_EXPIRES_IN=""                  # (900s) 운영 기본값이라 비워 두면 된다(D-03)
TRUST_PROXY=""                     # (1) 비우면 모든 사용자가 LB 주소 하나로 집계되어 함께 429 를 맞는다

# 채우지 않은 값이 있으면 여기서 멈춘다. 잘못된 설정으로 조용히 뜨는 것보다 낫다.
: "${APP_IMAGE:?APP_IMAGE 를 채울 것}"
: "${DATABASE_URL:?DATABASE_URL 을 채울 것}"
: "${JWT_SECRET:?JWT_SECRET 을 채울 것}"
: "${FRONTEND_URL:?FRONTEND_URL 을 채울 것}"
: "${OBJECT_STORAGE_ENDPOINT:?OBJECT_STORAGE_ENDPOINT 를 채울 것}"
: "${OBJECT_STORAGE_ACCESS_KEY:?OBJECT_STORAGE_ACCESS_KEY 를 채울 것}"
: "${OBJECT_STORAGE_SECRET_KEY:?OBJECT_STORAGE_SECRET_KEY 를 채울 것}"
: "${NCP_ACCESS_KEY:?NCP_ACCESS_KEY 를 채울 것}"
: "${NCP_SECRET_KEY:?NCP_SECRET_KEY 를 채울 것}"
# 비우면 lib/admin.ts 가 관리자 요청을 전부 403 으로 막는다. /health 는 정상이라 늦게 발견된다.
: "${ADMIN_ALLOWED_IP_CIDRS:?ADMIN_ALLOWED_IP_CIDRS 를 채울 것}"

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
  -e JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-900s}" \
  -e TRUST_PROXY="${TRUST_PROXY:-1}" \
  `# 마이그레이션은 배포 단계에서 한 번만 돌린다. 여러 대가 동시에 뜨므로 여기서는 끈다` \
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
