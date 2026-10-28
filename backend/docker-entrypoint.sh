#!/bin/sh
set -e

# 마이그레이션을 서버 기동에 묶어 두면 Auto Scaling 으로 N 대가 동시에 뜰 때
# N 번 실행된다. Prisma 가 잠금으로 직렬화하긴 하지만, 그만큼 기동이 늦어지고
# 한 대의 마이그레이션 실패가 그 인스턴스의 기동 실패로 이어진다.
#
# 그래서 배포 파이프라인에서 한 번만 돌리고, 서버는 적용된 DB 에 붙기만 하게 한다.
# 로컬 Compose 처럼 한 대만 뜨는 환경에서는 이 값을 켜 두면 편하다.
if [ "${RUN_MIGRATIONS_ON_START}" = "true" ]; then
  echo "applying database migrations"
  # npx 는 패키지가 없으면 레지스트리에서 받아오려 한다. 사설 서브넷에서는 그 경로가 막혀
  # 원인을 찾기 어려운 실패가 되므로, 설치된 실행 파일을 직접 부른다.
  ./node_modules/.bin/prisma migrate deploy
fi

exec node dist/src/server.js
