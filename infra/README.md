# Phase 1 로컬 인프라

## Docker 실행

루트에서 `.env.example`을 `.env`로 복사한 뒤 실행한다.

```bash
cp .env.example .env
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

- API: `http://localhost:8080`
- 상태 확인: `GET http://localhost:8080/health`
- MySQL: `localhost:3306`

컨테이너에서 마이그레이션은 API 시작 시 자동 적용된다. 시드가 필요하면 다음을 실행한다.

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec api npx tsx prisma/seed.ts
```

## 로컬 개발(백엔드만)

```bash
cd backend
npm install
copy ..\.env .env
npx prisma migrate deploy
npm run db:seed
npm run dev
```

Windows PowerShell에서는 `copy` 대신 `Copy-Item ..\.env .env`를 사용할 수 있다.

## Phase 3 NCP 전환 원칙

- MySQL 컨테이너는 Cloud DB for MySQL HA로 교체한다.
- API 컨테이너는 Private Subnet Server/Auto Scaling Group에 배포한다.
- 외부 요청은 Public Load Balancer만 수신한다.
- 비밀값은 `.env`가 아닌 NCP 환경변수·비밀 관리 수단으로 주입한다.
