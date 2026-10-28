# 까궁 (kkagung)

매일 오전 8시(KST)에 새로 열리는 **오늘의 운세**와 **익명 프로필 카드**로 호감을 표현하는 성인 대상 매칭 서비스입니다.

핵심 규칙이 하나 있습니다. **실제 사진과 상세 프로필은 상대가 채팅 요청을 수락한 뒤에만 공개됩니다.**
추천 카드에는 흐림 처리된 사진만 나가고, 원본은 비공개 버킷에 두었다가 수락한 참여자에게만
60초짜리 서명 URL 로 내보냅니다. 응답 어디에도 원본의 object key 를 넣지 않습니다.

> 운세는 오락 목적입니다.

## 지금 상태

| | |
|---|---|
| API | 45개 엔드포인트 |
| 자동 테스트 | 152개 (실제 MySQL + S3 호환 저장소 기준) |
| CI | GitHub Actions 3개 작업 — 백엔드 빌드·테스트, 프론트 구문 검사, Compose 설정 검증 |
| 배포 | NCP VPC 에 실제 기동. 구성과 절차는 [docs/07](docs/07_NCP_배포_절차.md) |

## 바로 실행해 보기

Docker 와 Docker Compose 만 있으면 됩니다. MySQL 과 S3 호환 저장소까지 함께 뜹니다.

```bash
# 1) 서명 키를 만든다. 이 값만 있으면 나머지는 기본값으로 뜬다.
echo "JWT_SECRET=$(openssl rand -hex 32)" > infra/.env

# 2) 세 서비스를 띄운다. 마이그레이션은 기동할 때 자동으로 적용된다.
docker compose -f infra/docker-compose.yml up -d --build

# 3) 확인
curl http://localhost:8080/health      # {"status":"ok","database":"connected"}
```

| | |
|---|---|
| 화면 | http://localhost:5173 |
| API | http://localhost:8080/api/v1 |

### 계정 만들기

가입 화면에서 직접 만들거나, 아래 중 하나를 넣습니다.

```bash
# 기능 확인용 계정 9개 (@kkagung.local)
docker compose -f infra/docker-compose.yml exec api node dist/prisma/seed.js

# 시연용 계정 21명 (@kkagung.demo). 사람처럼 보이는 프로필과 사진, 받은 하트·채팅방까지
node infra/demo/seed-demo.mjs
```

시연용 시드는 발표자 계정 `narae@kkagung.demo` 에 받은 하트 3개, 받은 채팅 요청 2개,
수락된 채팅방 하나를 미리 넣어 둡니다. 비밀번호는 모두 `kkagung123!` 입니다.
사진은 사람 사진이 아니라 사람마다 색이 다른 아바타를 그려 넣습니다.

### 테스트

```bash
cd backend && npm ci && npm test
```

실제 MySQL 과 저장소를 상대로 돌립니다. 위 Compose 가 떠 있어야 하고,
`DATABASE_URL`·`JWT_SECRET`·`OBJECT_STORAGE_*` 가 필요합니다. CI 설정이
[`.github/workflows`](.github/workflows) 에 그대로 있습니다.

## 구조

```text
kkagung/
├─ frontend/        바닐라 JS 정적 앱 (app.js · index.html · server.js)
├─ backend/         Express + TypeScript + Prisma(MySQL)
│  ├─ src/routes/   API
│  ├─ prisma/       스키마 · 마이그레이션 · 시드
│  └─ tests/        152개
├─ infra/
│  ├─ docker-compose.yml   로컬 3개 서비스
│  ├─ ncp/                 NCP 서버 Init Script
│  ├─ loadtest/            오전 8시 집중 부하 측정
│  ├─ demo/                시연용 시드
│  └─ security/            보안 점검 기록
└─ docs/            기획 · API · ERD · 아키텍처 · 배포 절차
```

## 문서

| | |
|---|---|
| [01 UX 시나리오](docs/01_UX_시나리오.md) · [02 화면별 기능](docs/02_화면별_기능정의.md) | 무엇을 만드는가 |
| [03 API 명세](docs/03_API_명세서.md) · [04 ERD](docs/04_ERD_및_테이블정의.md) | 계약과 데이터 |
| [05 NCP 아키텍처](docs/05_NCP_아키텍처.md) · [07 배포 절차](docs/07_NCP_배포_절차.md) | 어떻게 올리는가 |
| [06 결정사항](docs/06_결정사항_및_작업배분.md) | 왜 그렇게 정했는가 |
| [08 시연 시나리오](docs/08_시연_시나리오.md) | 무엇을 어떤 순서로 보여주는가 |
| [SECURITY_OPERATIONS](docs/SECURITY_OPERATIONS.md) | 보안·운영 기준 |

## 설계에서 신경 쓴 것

**수락 전에는 원본이 나가지 않는다.** 버킷을 둘로 나눴습니다(D-01). 공개 버킷에는 흐림본만,
원본은 비공개 버킷에만 둡니다. 객체별 권한 실수 하나로 경계가 무너지지 않도록 버킷으로 가릅니다.
업로드할 때 공개 권한을 붙일지는 호출부가 고르지 않고 버킷을 보고 정합니다.

**오전 8시에 몰리는 것을 전제로 만들었습니다.** 서비스 날짜 경계가 KST 08:00 이고, 같은 날
운세와 기본 추천은 다시 들어와도 같은 결과를 줍니다. 선착순 새로고침권은 트랜잭션과 row lock 으로
원자적으로 차감해, 동시에 몰려도 설정한 개수를 넘겨 발급되지 않습니다.

**권한은 토큰이 아니라 현재 DB 상태로 확인합니다.** 정지·강등된 계정의 기존 토큰이 관리자
API 를 통과하지 못하게 하기 위해서입니다. 관리자 동작은 감사 로그에 남습니다.

**속도 제한은 IP 와 계정 두 바구니로 나눴습니다.** 성공한 로그인은 한도에서 빼므로 정상 사용자가
잠기지 않습니다. 완화한 쪽과 유지한 쪽의 근거는 [SECURITY_OPERATIONS](docs/SECURITY_OPERATIONS.md) 에 적었습니다.

**AI 변환은 인터페이스만 두고 미뤘습니다(D-02).** 공급자가 정해지지 않아 `generationStatus` 를
`PENDING` 으로 두고, 화면에도 그대로 "AI 변환 준비 중" 으로 보여줍니다. 그동안은 흐림본이
공개본 역할을 합니다. 구현하지 않은 것을 구현한 것처럼 보이게 하지 않았습니다.

## 팀 작업 규칙

| 브랜치 | 용도 |
|---|---|
| `main` | 실행 가능한 안정 버전. 직접 커밋하지 않는다 |
| `develop` | 통합 브랜치. 모든 작업은 PR 로 들어온다 |
| `feature/*` | 역할별 작업 |

1. `main`·`develop` 에 직접 push 하지 않는다.
2. 비밀번호, API 키, JWT 시크릿, 실제 사용자 사진, `.env`, DB 덤프는 커밋하지 않는다.
3. API 를 바꾸면 [docs/03](docs/03_API_명세서.md) 을, 스키마를 바꾸면 마이그레이션과
   [docs/04](docs/04_ERD_및_테이블정의.md) 를 같은 PR 에서 함께 고친다.
4. 원본 사진은 서버에서만 접근 가능한 비공개 저장소에 두고, 수락 전에는 브라우저에
   원본 URL 을 전달하지 않는다.

역할별 담당 범위와 확정된 결정사항은 [docs/06](docs/06_결정사항_및_작업배분.md) 에 있습니다.
