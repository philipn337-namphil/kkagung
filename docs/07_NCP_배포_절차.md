# 07. NCP 배포 절차

> 구성 설계는 `05_NCP_아키텍처.md`에, 결정 근거는 `06_결정사항_및_작업배분.md`에 있다.
> 이 문서는 실제로 자원을 만들고 배포할 때 따라가는 순서다.

## 0. 배포 전 앱 설정

### 운영에서 반드시 지정할 값

| 키 | 값 | 지정하지 않으면 |
|---|---|---|
| `NODE_ENV` | `production` | 이미지 기본값이 `production`이라 비워도 되지만 명시한다 |
| `JWT_SECRET` | 32바이트 이상 무작위 | **기동 거부.** 짧은 값과 알려진 개발 키도 거부한다(SEC-09) |
| `JWT_EXPIRES_IN` | `900s` | 운영 기본값이 `900s`라 생략 가능(D-03) |
| `DATABASE_URL` | Cloud DB 접속 문자열 | 기동 실패 |
| `FRONTEND_URL` | 서비스 도메인 | CORS 가 막는다 |
| **`TRUST_PROXY`** | LB 홉 수(예: `1`) 또는 LB 대역 | **모든 사용자가 LB 주소 하나로 집계되어 함께 429 를 맞는다** |
| `RUN_MIGRATIONS_ON_START` | `false` | 인스턴스마다 마이그레이션이 실행된다 |
| `OBJECT_STORAGE_ENDPOINT` | NCP Object Storage 엔드포인트 | 사진 업로드 503 |
| `OBJECT_STORAGE_PUBLIC_ENDPOINT` | 브라우저가 공개 이미지를 받는 주소 | 비우면 위 엔드포인트를 그대로 쓴다 |
| `OBJECT_STORAGE_BUCKET_PUBLIC` | `kkagung-images-public` | 사진 업로드 503 |
| `OBJECT_STORAGE_BUCKET_PRIVATE` | `kkagung-images-private` | 사진 업로드 503 |
| `OBJECT_STORAGE_ACCESS_KEY` / `SECRET_KEY` | NCP 인증키 | 사진 업로드 503 |
| `ENABLE_TEST_ACCOUNTS` | 비움 | 운영에서는 켜도 라우터가 등록되지 않지만 비워 둔다 |
| `ADMIN_ALLOWED_IP_CIDRS` | 관리자 접속 대역 | 비우면 IP 제한을 적용하지 않는다 |

`TRUST_PROXY`를 빠뜨리면 기동은 되지만 부하가 몰리는 순간 전원이 429 를 맞는다. 배포 점검 항목에 반드시 넣는다.

### 시크릿을 두는 곳

`.env` 파일을 서버 이미지에 굽지 않는다. 이미지가 유출되면 키가 함께 나간다.
NCP 콘솔의 서버 환경변수 또는 Init Script 가 기동 시점에 주입하고, 값 자체는 저장소·이미지·로그 어디에도 남기지 않는다.

### 마이그레이션은 배포 단계에서 한 번만

컨테이너는 `RUN_MIGRATIONS_ON_START` 가 `true` 일 때만 마이그레이션을 적용한다.
여러 대가 동시에 뜨면 N 번 실행되므로 운영에서는 끄고, 배포 파이프라인에서 한 번 돌린다.

```bash
# 배포 단계 (한 번만)
docker run --rm -e DATABASE_URL="$DATABASE_URL" -e JWT_SECRET="$JWT_SECRET" \
  -e RUN_MIGRATIONS_ON_START=true <이미지> ./node_modules/.bin/prisma migrate deploy

# 서버 인스턴스
RUN_MIGRATIONS_ON_START=false
```

### 프론트

`API_BASE_URL` 환경변수를 서비스 도메인(HTTPS)으로 준다. 코드 수정은 필요 없다.
정적 파일은 allowlist 로 제한되어 있어 `server.js`·`.env` 같은 파일은 제공되지 않는다(SEC-11).

---

## 1. 네트워크

| 자원 | 이름 | 대역 | 비고 |
|---|---|---|---|
| VPC | `kkagung-vpc` | `10.0.0.0/16` | |
| Subnet | `kkagung-sn-lb` | `10.0.1.0/24` | 로드밸런서 전용, 공인 |
| Subnet | `kkagung-sn-app` | `10.0.10.0/24` | 비공인 |
| Subnet | `kkagung-sn-db` | `10.0.20.0/24` | 비공인 |

ACG 는 IP 대역이 아니라 **다른 ACG 를 출발지로** 지정한다. 서버가 늘어도 규칙을 고치지 않기 위해서다.

| ACG | 인바운드 허용 |
|---|---|
| `kkagung-acg-lb` | 인터넷 → 443 |
| `kkagung-acg-app` | `kkagung-acg-lb` → 8080 |
| `kkagung-acg-db` | `kkagung-acg-app` → 3306 |

NACL 은 서브넷 단위로 위 경로 외의 인·아웃바운드를 차단한다.

---

## 2. 데이터

**Cloud DB for MySQL** — `kkagung-sn-db` 에 배치, HA 구성, 자동 백업과 시점 복원을 켠다. 접속은 `kkagung-acg-db` 로만 연다.

**Object Storage** — 버킷 두 개를 만든다(D-01).

| 버킷 | 공개 설정 |
|---|---|
| `kkagung-images-public` | 익명 읽기 허용. AI·흐림 이미지만 들어간다 |
| `kkagung-images-private` | 비공개. 원본만 들어간다. 서버가 발급한 서명 URL 로만 읽는다 |

애플리케이션에는 **버킷 생성 권한을 주지 않는다.** 로컬에서만 없으면 만들고, 운영에서는 인프라가 정책까지 포함해 미리 만든다.

---

## 3. 앱 서버와 로드밸런서

1. 서버 이미지에 Docker 와 애플리케이션 이미지를 포함한다
2. Init Script 가 환경변수를 주입하고 컨테이너를 기동한다 (`RUN_MIGRATIONS_ON_START=false`)
3. Load Balancer 를 `kkagung-sn-lb` 에 만들고 HTTPS 리스너에 인증서를 붙인다
4. 헬스체크 경로는 `/health` 로 둔다. DB 연결까지 확인하므로 DB 가 끊긴 인스턴스는 자동으로 빠진다

---

## 4. Auto Scaling 과 관측

- Launch Configuration 에 위 서버 이미지를 지정하고 평시 최소 대수를 둔다
- Cloud Insight 로 CPU·요청 수·응답 시간·오류율·서버 수를 본다
- 8시 집중 구간에 증설하고 이후 축소한다

---

## 5. 부하 테스트

로컬에서 쓴 도구를 그대로 쓴다. `--base` 로 서비스 주소를 준다.

```bash
node infra/loadtest/seed-load.mjs --count 2000
node infra/loadtest/run-load.mjs --base https://<서비스 도메인> --users 500 --concurrency 50 --reset
node infra/loadtest/seed-load.mjs --clean
```

원격 DB 에 시드하려면 `ALLOW_REMOTE_LOAD_SEED=true` 가 필요하다. 실수로 운영 DB 에 넣지 않도록 둔 장치다.

### 로컬 기준값 (노트북 한 대에서 DB·API 동시 구동)

사용자 2,000명 / 동시 30

| | |
|---|---|
| `daily/open` | p50 1,851ms · p95 2,405ms |
| `recommendations` | p50 278ms |
| 처리량 | 초당 25건 |

NCP 에서는 DB 가 분리되고 서버가 늘어나므로 이 값보다 나아야 한다. 그렇지 않으면 구성 문제를 먼저 의심한다.

### 확인할 것

- 8시 동시 접속에서 응답 시간과 오류율
- **선착순 새로고침권이 설정한 개수만 발급됐는지** DB 로 확인
- Auto Scaling 이 실제로 증설·축소하는지
- 인스턴스를 강제 종료했을 때 LB 가 빼고 재생성되는지
- 수락 전 원본 사진 접근이 거부되는지
- DB 시점 복원

---

## 배포 점검표

- [ ] `TRUST_PROXY` 를 지정했는가 (빠뜨리면 전원 429)
- [ ] `RUN_MIGRATIONS_ON_START=false` 인가
- [ ] 마이그레이션을 배포 단계에서 한 번 적용했는가
- [ ] `JWT_SECRET` 이 이미지·저장소·로그에 남지 않는가
- [ ] 원본 버킷이 비공개인가
- [ ] `FRONTEND_URL` 과 `API_BASE_URL` 이 HTTPS 도메인인가
- [ ] `/health` 가 LB 헬스체크에 연결됐는가
