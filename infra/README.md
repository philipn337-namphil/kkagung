# 로컬 인프라

## 환경변수

루트 `.env` 하나를 Compose와 백엔드가 함께 쓴다. `.env`는 커밋하지 않는다(`.gitignore`에 이미 포함).

### 반드시 직접 넣어야 하는 값

| 키 | 설명 |
|---|---|
| `JWT_SECRET` | **32바이트 이상 무작위 값.** 길이가 짧거나 알려진 개발 기본키면 API가 시작을 거부한다(SEC-09). 기본값을 두지 않았으므로 없으면 `docker compose`가 바로 실패한다. |

생성 방법 (값을 화면에 띄우지 않고 바로 `.env`에 기록한다):

```powershell
"JWT_SECRET=$([Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 } | ForEach-Object { [byte]$_ })))" | Add-Content .env
```

```bash
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
```

### 기본값이 있어 생략 가능한 값

| 키 | 기본값 | 비고 |
|---|---|---|
| `APP_ENV` | `development` | `production`이면 가입 차단·TTL 단축 등이 적용된다 |
| `JWT_EXPIRES_IN` | `12h` | D-03. 단위(`s`/`m`/`h`/`d`) 필수. 운영은 `900s` |
| `FRONTEND_URL` | `http://localhost:5173` | CORS 허용 Origin |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `kkagung` / `kkagung_app` / `change_me` | 로컬 전용. 외부 노출 환경에서는 반드시 변경 |
| `OBJECT_STORAGE_ENDPOINT` | (빈 값) | D-01. **비우면 추천 카드의 `publicImage`가 `null`로 나간다** |
| `OBJECT_STORAGE_BUCKET_PUBLIC` | `kkagung-images-public` | D-01. AI·블러 이미지 |
| `OBJECT_STORAGE_BUCKET_PRIVATE` | `kkagung-images-private` | D-01. 원본. 서버만 접근 |
| `ENABLE_TEST_ACCOUNTS` | `false` | 시연용 `/api/v1/dev` 라우터. 운영 환경에서는 켜도 등록되지 않는다 |
| `ADMIN_ALLOWED_IP_CIDRS` | (빈 값) | 비우면 관리자 IP 제한을 적용하지 않는다 |
| `SEED_PASSWORD` | `kkagung123!` | 시드 계정 비밀번호. 로컬 전용 |

`AUTH_JWT_ISSUER`(`kkagung-api`), `AUTH_JWT_AUDIENCE`(`kkagung-client`)는 코드 기본값을 쓰며 보통 건드리지 않는다. 바꾸면 기존에 발급된 토큰이 모두 무효가 된다.

## Docker 실행

```bash
cp .env.example .env
# 위 생성 명령으로 JWT_SECRET 을 .env 에 추가한 뒤 실행한다.
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
