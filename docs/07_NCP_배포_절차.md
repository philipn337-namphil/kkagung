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
| `DATABASE_URL` | Cloud DB 접속 문자열 | 기동 실패. **비밀번호의 `@`·`#`·`/` 는 퍼센트 인코딩한다(`%40`·`%23`·`%2F`).** 안 하면 호스트 이름이 잘려 접속이 실패한다 |
| `FRONTEND_URL` | 서비스 도메인 | CORS 가 막는다 |
| **`TRUST_PROXY`** | LB 홉 수(예: `1`) 또는 LB 대역 | **모든 사용자가 LB 주소 하나로 집계되어 함께 429 를 맞는다** |
| `RUN_MIGRATIONS_ON_START` | `false` | 인스턴스마다 마이그레이션이 실행된다 |
| `OBJECT_STORAGE_ENDPOINT` | NCP Object Storage 엔드포인트 | 사진 업로드 503 |
| `OBJECT_STORAGE_PUBLIC_ENDPOINT` | 브라우저가 공개 이미지를 받는 주소 | 비우면 위 엔드포인트를 그대로 쓴다 |
| `OBJECT_STORAGE_BUCKET_PUBLIC` | `kkagung-images-public` | 사진 업로드 503 |
| `OBJECT_STORAGE_BUCKET_PRIVATE` | `kkagung-images-private` | 사진 업로드 503 |
| `OBJECT_STORAGE_ACCESS_KEY` / `SECRET_KEY` | NCP 인증키 | 사진 업로드 503 |
| `ENABLE_TEST_ACCOUNTS` | 비움 | 운영에서는 켜도 라우터가 등록되지 않지만 비워 둔다 |
| `FRONTEND_IMAGE` | 프론트도 같은 서버에 둘 때만 | 비우면 API 컨테이너만 뜬다 |
| `APP_IMAGE` | `<레지스트리>.kr.ncr.ntruss.com/kkagung-api:<태그>` | Init Script 가 기동 전에 멈춘다 |
| `NCP_ACCESS_KEY` / `NCP_SECRET_KEY` | NCP API 인증키 | 레지스트리 로그인 실패로 기동하지 않는다 |
| **`ADMIN_ALLOWED_IP_CIDRS`** | 관리자 접속 대역 | **운영에서 비우면 관리자 API 가 전부 403 이다.** 개발에서만 "제한 없음"으로 동작한다 |

`TRUST_PROXY`를 빠뜨리면 기동은 되지만 부하가 몰리는 순간 전원이 429 를 맞는다. 배포 점검 항목에 반드시 넣는다.

### 시크릿을 두는 곳

`.env` 파일을 서버 이미지에 굽지 않는다. 이미지가 유출되면 키가 함께 나간다.

**NCP VPC 서버 생성 화면에는 환경변수를 넣는 칸이 없다.** 고를 수 있는 것은 미리 콘솔에
저장해 둔 Init Script 하나뿐이다. 값을 스크립트 바깥에서 넘길 수단이 없다.

검토한 대안과 그 한계:

| 대안 | 왜 쓰지 않나 |
|---|---|
| Secret Manager | `Get Secret Value` 호출에 `x-ncp-iam-access-key` 와 서명 헤더가 필요하다. 비밀을 가져오려고 비밀이 먼저 있어야 한다 |
| Server Role | 서버에 역할을 붙여 키 없이 호출하는 방식이 KMS 문서에는 있으나, Secret Manager 에도 적용되는지 문서로 확인되지 않았다. 확인 안 된 경로에 배포를 걸지 않는다 |

그래서 **Init Script 본문에 값을 직접 적는다.** 저장소의 `infra/ncp/init-script.sh` 는
값이 빈 템플릿으로 두고, 값을 채운 사본은 콘솔에만 둔다.

```sh
# 저장소 (커밋하는 것)          # 콘솔 (커밋하지 않는 것)
DATABASE_URL=""                DATABASE_URL="mysql://kkagung_app:<비밀번호>@<주소>:3306/kkagung"
JWT_SECRET=""                  JWT_SECRET="<32바이트 이상 무작위>"
```

템플릿은 값이 비면 기동 전에 멈춘다. 채우지 않은 채로 올려도 조용히 잘못 뜨지 않는다.

**감수하는 것:** 콘솔 접근 권한이 있는 사람에게 값이 평문으로 보인다. 교육용 데모 범위에서
받아들인다. 실서비스로 전환한다면 Server Role 적용 여부를 먼저 확인하고 Secret Manager 로 옮긴다.

**그래도 지키는 것:** 값이 채워진 사본을 저장소에 커밋하지 않는다. 이미지에도 굽지 않는다.
`.env.example` 에는 키 이름만 둔다.

### 마이그레이션은 배포 단계에서 한 번만

컨테이너는 `RUN_MIGRATIONS_ON_START` 가 `true` 일 때만 마이그레이션을 적용한다.
여러 대가 동시에 뜨면 N 번 실행되므로 운영에서는 끄고, 배포 파이프라인에서 한 번 돌린다.

```bash
# 배포 단계 (한 번만)
docker run --rm -e DATABASE_URL="$DATABASE_URL" -e JWT_SECRET="$JWT_SECRET" \
  <이미지> ./node_modules/.bin/prisma migrate deploy

# 서버 인스턴스
RUN_MIGRATIONS_ON_START=false
```

#### 어디서 실행하나 — 앱 서버 안에서다

Cloud DB 는 비공인 서브넷에 있고, DB 계정의 `HOST(IP)` 를 `10.0.10.%`(앱 서브넷)로 묶어 두었다.
**공인 서브넷의 징검다리 서버에서는 DB 에 붙지 못한다.** ACG 를 열어도 계정이 막는다.
그래서 마이그레이션은 앱 서버 안에서 돌린다. 앱 서버에는 이미 이미지가 받아져 있다.

앱 서버에는 공인 IP 가 없어 바로 들어갈 수 없으므로 징검다리를 거친다.

```
작업자 → 징검다리(공인 서브넷) → 앱 서버(10.0.10.x) → docker run ... migrate deploy
```

징검다리는 서버 이미지를 만들 때 쓴 `kkagung-sn-build` 서버를 그대로 쓰면 된다.
마이그레이션까지 끝낸 뒤에 반납한다.

**징검다리에서 앱 서버로 들어가려면 ACG 규칙이 하나 더 필요하다.** `kkagung-acg-app` 의
인바운드는 LB 에서 오는 8080·5173 만 허용한다. `kkagung-acg-build` 를 출발지로 22 를 연다.
마이그레이션이 끝나면 그 규칙도 지운다.

#### 테이블이 없어도 `/health` 는 통과한다

`/health` 는 `SELECT 1` 이라 **빈 DB 에서도 200 을 돌려준다.** 마이그레이션을 빠뜨리면
서버는 정상으로 떠 보이고 LB 헬스체크도 통과하는데 API 만 전부 실패한다.
기동 직후에 실제 테이블을 쓰는 경로를 한 번 불러 확인한다.

```bash
# 401 이면 테이블이 있다. 계정이 없을 뿐이다. 500 이면 마이그레이션이 적용되지 않았다.
curl -s -o /dev/null -w '%{http_code}' -X POST http://<LB 주소>/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"x@x.x","password":"x"}'; echo
```

#### 데모 계정이 필요하면

같은 자리에서 시드를 한 번 돌린다. 저장소 설정이 있으면 자리 표시 사진까지 올라간다.
`tsx` 는 devDependency 라 운영 이미지에 없다. 빌드된 `dist/prisma/seed.js` 를 부른다.

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" -e JWT_SECRET="$JWT_SECRET" \
  -e OBJECT_STORAGE_ENDPOINT=... -e OBJECT_STORAGE_ACCESS_KEY=... -e OBJECT_STORAGE_SECRET_KEY=... \
  -e OBJECT_STORAGE_BUCKET_PUBLIC=kkagung-images-public -e OBJECT_STORAGE_BUCKET_PRIVATE=kkagung-images-private \
  <이미지> node dist/prisma/seed.js
```

`ENABLE_TEST_ACCOUNTS` 는 계속 비워 둔다. 시드 계정은 만들되, 토큰을 그냥 내주는
개발용 라우터는 열지 않는다.

### 프론트

프론트는 **앱 서버에 API 컨테이너와 함께 띄우고, LB 가 경로로 나눠 보낸다.**

```
/api/*  → 앱 컨테이너  8080
그 외    → 프론트 컨테이너 5173
```

같은 주소에서 화면과 API 가 모두 나오므로, 제출물을 받는 사람이 LB 주소 하나로 화면까지 본다.

#### CORS 는 Origin 하나만 허용한다

`app.ts` 가 `cors({ origin: config.corsOrigin })` 로 값 하나만 받는다. allowlist 가 아니라
**브라우저가 보는 주소와 정확히 같아야 한다.** 위 구성에서는 프론트와 API 가 같은 Origin 이라
`FRONTEND_URL` 과 브라우저 주소가 자연히 일치한다.

#### `API_BASE_URL` 은 `/` 로 둔다

같은 Origin 이므로 절대 주소가 필요 없다. 코드 수정도 필요 없다.

```
API_BASE_URL=/  →  window.API_BASE_URL = "/"  →  요청 경로 /api/v1/...
```

`app.js` 가 끝의 `/` 를 떼고 `/api/v1` 을 붙이므로 그대로 상대경로가 된다. 실제로 확인했다.

정적 파일은 allowlist 로 제한되어 있어 `server.js`·`.env` 같은 파일은 제공되지 않는다(SEC-11).

---

## 1. 네트워크

| 자원 | 이름 | 대역 | 비고 |
|---|---|---|---|
| VPC | `kkagung-vpc` | `10.0.0.0/16` | |
| Subnet | `kkagung-sn-lb` | `10.0.1.0/24` | 로드밸런서 전용, 공인 |
| Subnet | `kkagung-sn-app` | `10.0.10.0/24` | 비공인 |
| Subnet | `kkagung-sn-db` | `10.0.20.0/24` | 비공인 |
| Subnet | `kkagung-sn-nat` | `10.0.2.0/24` | NAT Gateway 전용, 공인 |
| NAT Gateway | `kkagung-natgw` | | 공인 IP 할당 |

실제로 만든 자원은 아래와 같다. 이후 단계에서 이 이름으로 지정한다.

```
VPC     kkagung-vpc         151444
Subnet  kkagung-sn-lb       332078   10.0.1.0/24    공인   LoadBalancer
        kkagung-sn-app      332079   10.0.10.0/24   사설   일반
        kkagung-sn-db       332080   10.0.20.0/24   사설   일반
        kkagung-sn-nat      332184   10.0.2.0/24    공인   NatGateway
ACG     kkagung-acg-lb      411093   (미사용 - LB 는 ACG 를 가질 수 없다)
        kkagung-acg-app     411094
        kkagung-acg-db      411095   (미사용)
        cloud-mysql-2f8r8p  411098   Cloud DB 가 자동 생성
NATGW   kkagung-natgw                공인 IP 211.233.206.191 / 사설 10.0.2.6
```

`kkagung-acg-db` 는 Cloud DB 가 전용 ACG 를 따로 만들기 때문에 쓰이지 않는다. 2단계를 참고한다.

ACG 는 되도록 IP 대역이 아니라 **다른 ACG 를 출발지로** 지정한다. 서버가 늘어도 규칙을
고치지 않기 위해서다. **단 LB → 서버 구간은 예외다.** 아래를 먼저 읽는다.

| ACG | 인바운드 허용 | 아웃바운드 허용 |
|---|---|---|
| `kkagung-acg-app` | `10.0.1.0/24`(LB 서브넷) → 8080, 5173 | **열어야 한다.** 아래 참고 |
| `cloud-mysql-*` | `kkagung-acg-app` → 3306 | Cloud DB 가 자동으로 만든다 |

#### LB 는 ACG 를 가질 수 없다

**Load Balancer 는 NCP 관리형이라 사용자 ACG 에 속하지 않는다.** 생성 마법사에 ACG 를
고르는 칸 자체가 없다(유형·이름·네트워크·부하처리성능·VPC·서브넷뿐).
그래서 `kkagung-acg-lb` 를 만들어 두어도 적용 Network Interface 수가 0 인 채로 남고,
**그걸 출발지로 쓴 규칙은 영원히 매칭되지 않는다.**

LB 서브넷 대역(`10.0.1.0/24`)을 직접 허용한다. 여기서만 ACG 대신 대역을 쓴다.

```
kkagung-acg-app  in: 10.0.1.0/24 → 8080   (API)
                 in: 10.0.1.0/24 → 5173   (프론트)
```

증상이 알아보기 어렵다. Target 상태가 **`DOWN` · `TCP TIMEOUT`** 으로 뜬다.
`connection refused` 가 아니다. 컨테이너는 멀쩡히 떠 있는데 LB 쪽 패킷이 ACG 에서
버려지는 것이고, LB 는 503 만 돌려주므로 서버에 들어가 보면 전부 정상으로 보인다.

`kkagung-acg-lb`(411093) 는 쓰이지 않는다. `kkagung-acg-db`(411095) 와 같은 경우다.

**아웃바운드는 기본이 비어 있고, NCP ACG 는 규칙에 없으면 막는다.**
`kkagung-acg-app` 의 아웃바운드를 열지 않으면 Container Registry 와 Object Storage 로 나가지 못한다.
둘 다 공인 주소라 NAT Gateway 와 라우트가 전부 맞아도 소용이 없다.
증상은 `docker pull` 타임아웃 하나뿐이라, 없는 NAT 문제를 먼저 의심하게 된다.

#### 차단은 ACG 가 한다. NACL 은 기본값 그대로다

`kkagung-vpc` 에는 기본 NACL 하나만 있고 그 안에 규칙이 **0개**다. NCP 기본 NACL 은
규칙이 비면 전부 허용이므로, **지금 NACL 은 아무것도 막지 않는다.** 위 ACG 표가
실제로 적용되는 유일한 제한이다. 설계 문서에 NACL 이 차단한다고 적혀 있었으나 사실이 아니다.

지금 NACL 을 넣지 않기로 했다. NACL 은 stateless 라 응답이 돌아올 임시 포트까지
양방향으로 직접 열어야 하고, 하나라도 빠뜨리면 지금 도는 LB·NAT·DB 경로가 한꺼번에 끊긴다.
ACG 가 이미 서브넷별로 출발지와 포트를 좁게 제한하고 있어 더해지는 것도 적다.

운영으로 전환해 다층 방어가 필요해지면 그때 추가한다. 그때는 임시 포트 범위
(1024-65535)를 양방향으로 함께 설계한다.

### 앱 서브넷의 아웃바운드 — NAT Gateway

앱 서버는 비공인 서브넷에 있어 Object Storage(공인 주소)에 닿지 못한다. 그대로 두면 사진 업로드가 전부 실패한다.
Private Link 는 쓸 수 없다. `Naver Cloud Platform Service` 목록에 Object Storage 가 없다. 그래서 NAT Gateway 로 나간다.

NAT Gateway 는 **용도가 `NATGW` 인 전용 서브넷**을 요구한다. 일반 공인 서브넷이나 LB 전용 서브넷은 선택지에 뜨지 않는다.

1. 서브넷 `kkagung-sn-nat` — `10.0.2.0/24`, KR-1, 공인, 용도 **NATGW**
2. NAT Gateway `kkagung-natgw` — 공인 IP 함께 신청
3. 앱 서브넷의 Route Table 에 `0.0.0.0/0 → NATGW kkagung-natgw` 추가

**3번을 빠뜨리면 자원은 다 있는데 트래픽이 흐르지 않는다.** 증상은 업로드 타임아웃뿐이라 원인을 찾기 어렵다.

#### 기본 사설 Route Table 을 그대로 쓰면 DB 서브넷까지 열린다

`kkagung-vpc-default-private-table` 에는 `kkagung-sn-app` 과 `kkagung-sn-db` 가 **함께** 묶여 있다.
여기에 기본 경로를 넣으면 DB 서브넷도 인터넷으로 나갈 수 있게 된다. DB 는 나갈 일이 없고,
나갈 수 있으면 침해 시 데이터를 밖으로 빼낼 길이 생긴다.

앱 전용 Route Table 을 따로 만들어 분리한다.

```
Route Table 생성   kkagung-rt-app   사설
  Routes          0.0.0.0/0 → NATGW kkagung-natgw
  연관 Subnet      kkagung-sn-app

kkagung-vpc-default-private-table 에서 0.0.0.0/0 경로 삭제
  → kkagung-sn-db 는 LOCAL 만 남는다
```

---

## 2. 데이터

### Cloud DB for MySQL

| 항목 | 값 | 비고 |
|---|---|---|
| 엔진 | mysql 8.4 | 로컬 `mysql:8.4` 와 같은 계열로 맞춘다 |
| 서브넷 | `kkagung-sn-db` | Private |
| 고가용성 | 사용 | |
| 서버 스펙 | vCPU 2 / 8GB 이상 | 최소 사양이면 부하 테스트에서 DB 가 먼저 병목이 된다 |
| 기본 DB 명 | `kkagung` | |
| 사용자 | `kkagung_app` | |
| `HOST(IP)` | `10.0.10.%` | 앱 서브넷 대역으로 제한한다. ACG 가 잘못돼도 계정이 한 번 더 막는다 |
| 백업 | 사용, **보관 7일 이상** | 기본값 1일이면 하루 지나 발견한 문제를 되돌릴 수 없다 |
| 백업 시간 | 오전 8시를 피한 시각 | 서비스 피크와 겹치지 않게 |
| 반납 보호 | 설정 | 실수로 Master DB 를 지우는 것을 막는다 |
| DB Config | 기본 템플릿 | 아래 시간대 참고 |

**ACG 는 자동 생성된다.** Cloud DB 는 `cloud-mysql-*` 형태의 전용 ACG 를 스스로 만든다.
직접 만든 ACG 를 붙이는 구조가 아니므로, 생성이 끝난 뒤 그 자동 생성 ACG 에 규칙을 넣는다.

```
cloud-mysql-*   접근 소스: kkagung-acg-app   포트: 3306
```

#### DB 시간대는 맞추지 않아도 된다

마이그레이션에 `DEFAULT CURRENT_TIMESTAMP(3)` 가 16곳 있어 DB 시계를 쓰는 것처럼 보이지만,
Prisma Client 가 `@default(now())` 값을 **애플리케이션에서 계산해 INSERT 에 실어 보낸다.**
실제 INSERT 문에 `created_at` 컬럼이 포함되는 것으로 확인했다. DB 의 `time_zone` 설정과 무관하다.

#### 저장 데이터 암호화

교육용 계정에서는 선택할 수 없어 적용하지 않았다. 생성 이후에는 변경할 수 없으므로,
실서비스로 전환할 때 다시 검토한다. 현재는 비공인 서브넷 배치, ACG 제한, DB 계정 호스트 제한,
로그 마스킹(SEC-08), 원본 사진을 DB 가 아닌 비공개 버킷에 두는 구성으로 대응한다.

### Object Storage

버킷 두 개를 만든다(D-01).

| 버킷 | 공개 설정 |
|---|---|
| `kkagung-images-public` | 익명 읽기 허용. AI·흐림 이미지만 들어간다 |
| `kkagung-images-private` | 비공개. 원본만 들어간다. 서버가 발급한 서명 URL 로만 읽는다 |
| `kkagung-registry` | 비공개. Container Registry 전용. 사진과 섞지 않는다(3단계 참고) |

애플리케이션에는 **버킷 생성 권한을 주지 않는다.** 로컬에서만 없으면 만들고, 운영에서는 인프라가 정책까지 포함해 미리 만든다.

엔드포인트는 `https://kr.object.ncloudstorage.com`, 리전은 `kr-standard`, 주소는 경로 방식이다.
`OBJECT_STORAGE_PUBLIC_ENDPOINT` 도 같은 값을 쓴다. 브라우저가 받는 공개 이미지 주소는
`https://kr.object.ncloudstorage.com/kkagung-images-public/<object key>` 가 된다.

#### 버킷의 "공개"는 목록 공개다. 객체 공개가 아니다

콘솔의 권한 관리에서 전체 공개를 켜면 **누구나 버킷의 파일 목록을 조회**할 수 있게 된다.
개별 파일의 공개 여부는 거기서 정해지지 않고, 올릴 때 객체 ACL 로 따로 준다.
두 가지가 별개라서 다음 두 조합이 모두 쉽게 나온다.

| 버킷 전체 공개 | 객체 ACL | 결과 |
|---|---|---|
| 공개 | 없음 | 목록은 누구나 받아가는데 정작 이미지는 403 이다 |
| 공개 안함 | `public-read` | **이게 맞는 조합** |

공개 버킷에 두 버킷 모두 **전체 공개를 "공개 안함"으로** 둔다. 목록을 열어 둘 이유가 없다.
객체 키가 `profiles/blur/<userId>/<uuid>.webp` 라, 목록이 열려 있으면 인증 없는 요청 한 번에
사용자 ID 목록과 흐림 사진 전부가 나간다.

객체 공개는 애플리케이션이 업로드 시점에 준다. `lib/objectStorage.ts` 의 `putObject` 가
**버킷을 보고** 공개 버킷이면 `public-read` 를, 원본 버킷이면 아무 권한도 붙이지 않는다.
호출부가 고르지 않으므로 원본에 공개 권한이 붙는 실수가 나오지 않는다(D-01).

```bash
# 목록이 열려 있으면 ListBucketResult 가, 막혀 있으면 AccessDenied 가 돌아온다. 둘 다 후자여야 한다.
curl -s https://kr.object.ncloudstorage.com/kkagung-images-public/
curl -s https://kr.object.ncloudstorage.com/kkagung-images-private/

# 사진을 한 장 올린 뒤, 흐림본은 인증 없이 열리고 원본은 열리지 않아야 한다.
curl -s -o /dev/null -w '%{http_code}
' https://kr.object.ncloudstorage.com/kkagung-images-public/<흐림본 키>
curl -s -o /dev/null -w '%{http_code}
' https://kr.object.ncloudstorage.com/kkagung-images-private/<원본 키>
```

로컬·CI 저장소는 ACL 을 구현하지 않아 익명 접근이 양쪽 다 거부된다.
**실제 공개 여부는 NCP 에서만 확인된다.** 자동 테스트는 버킷에 맞는 권한이 요청에 실리는지까지만 본다.

---

## 3. 앱 서버와 로드밸런서

### 이미지는 Container Registry 를 거친다

서버 이미지에는 Docker 만 넣고, 애플리케이션 이미지는 기동할 때 받는다.
이미지를 서버 이미지에 구우면 백엔드를 한 줄 고칠 때마다 서버 이미지를 다시 만들어야 하고,
Auto Scaling 으로 증설된 서버가 옛 코드로 뜬다.

레지스트리 주소는 공인이다. VPC 에서는 Private Endpoint 를 쓸 수 없으므로(Classic 전용)
**앱 서브넷의 NAT Gateway 경로가 여기서 쓰인다.** 경로가 없으면 `docker pull` 에서 멈춘다.

로그인 계정은 Object Storage 와 같은 NCP API 인증키다. Access Key ID 가 아이디,
Secret Key 가 비밀번호다.

```bash
# 로컬 또는 CI 에서 한 번
docker build -t "${REGISTRY}/kkagung-api:$(git rev-parse --short HEAD)" backend
printf '%s' "$NCP_SECRET_KEY" | docker login "$REGISTRY" -u "$NCP_ACCESS_KEY" --password-stdin
docker push "${REGISTRY}/kkagung-api:$(git rev-parse --short HEAD)"
```

태그는 커밋 해시로 둔다. `latest` 로 두면 증설된 서버가 어떤 코드로 떴는지 알 수 없고,
되돌릴 지점도 사라진다.

### 확정된 값

```
레지스트리            kkagung
Public Endpoint      kkagung.kr.ncr.ntruss.com      ← VPC 에서는 이쪽을 쓴다
Private Endpoint     ...kr.private-ncr.ntruss.com   ← Classic 전용. VPC 에서 쓸 수 없다
저장 버킷             kkagung-registry
```

### 순서

1. **레지스트리 전용 버킷을 먼저 만든다** — `kkagung-registry`
   레지스트리 생성 폼에서 저장 버킷을 고르는데, 목록에 사진 버킷만 떠서 모르고 고르기 쉽다.
   원본 사진 버킷은 "수락 전 신원 노출을 막는" 경계다(D-01). 성격이 다른 도커 레이어를 섞으면
   그 경계가 흐려지고, 버킷 단위 권한·수명주기·용량이 서로 얽힌다.
   업로드 회귀 테스트도 그 버킷에 `ListObjectsV2` 를 쓰므로, 설정이 운영 버킷을 가리키면
   레지스트리 객체까지 집계한다.
2. Container Registry 에 레지스트리를 만들고 저장 버킷으로 위 버킷을 고른 뒤, 아래 명령으로 이미지를 올린다
3. **서버 이미지를 만든다.** `kkagung-sn-app` 은 비공인이라 SSH 로 들어갈 수 없다.
   공인 일반 서브넷에 임시 서버를 띄워 만들고, 끝나면 반납한다.
   서버 이미지는 서브넷과 무관하게 재사용되므로, 진짜 앱 서버는 `kkagung-sn-app` 에 그대로 띄운다.

   ```
   a. 서브넷 kkagung-sn-build (10.0.3.0/24, KR-1, 공인, 일반) + ACG kkagung-acg-build 생성
      ACG 인바운드는 TCP 22 를 작업자 IP 한 대로만 연다
   b. 임시 서버를 띄워 SSH 로 접속, Docker 설치
      애플리케이션 이미지는 넣지 않는다. 기동할 때 레지스트리에서 받는다
   c. 서버 이미지 생성
   d. 임시 서버·공인 IP·서브넷·ACG 반납
   ```
4. 서버는 `kkagung-sn-app` 에 만들고 ACG 는 `kkagung-acg-app` 을 붙인다
   - **이 ACG 의 아웃바운드가 열려 있어야 한다**(1단계 참고). 비어 있으면 `docker pull` 에서 멈춘다
5. Init Script 를 먼저 콘솔에 등록하고(서버 생성 화면에서 고르려면 미리 있어야 한다),
   서버 설정 단계에서 그 스크립트를 고른다 — `infra/ncp/init-script.sh`
   - 등록할 때 상단 블록의 큰따옴표 안을 채운다. 채운 사본은 콘솔에만 둔다
   - **콘솔은 ASCII 만 받는다.** 한글이 들어가면 저장이 거부된다. 그래서 저장소의
     `init-script.sh` 는 주석과 오류 메시지가 영문이다. 등록할 때 번역해 쓰면 저장소
     사본과 어긋나므로, 그 파일을 그대로 붙여넣고 값만 채운다
   - 필수 값이 없으면 기동 전에 멈춘다. 조용히 잘못된 설정으로 뜨는 것을 막는다
   - 레지스트리 비밀번호는 표준입력으로 넘긴다. 인자로 주면 `ps` 출력에 그대로 보인다
   - 받아오기를 먼저 하고 기존 컨테이너를 지운다. 반대로 하면 `pull` 이 실패했을 때
     되돌릴 것 없이 서비스만 내려간다
   - 끝나면 `docker logout` 한다. 자격증명이 인스턴스의 `~/.docker/config.json` 에 남는다
   - `TRUST_PROXY` 기본 `1`, `RUN_MIGRATIONS_ON_START` 는 `false` 로 고정
   - 기동 후 `/health` 가 통과할 때까지 기다린다. 실패하면 컨테이너 로그를 남기고 종료한다
6. Application Load Balancer 를 `kkagung-sn-lb` 에 만든다
   - 리스너는 **HTTP 80**. 도메인을 확보하지 못해 인증서를 붙일 수 없다(아래 참고)
   - 경로 규칙으로 `/api/*` 는 8080, 나머지는 5173 으로 보낸다
   - **LB 는 ACG 를 고를 수 없다.** 앱 ACG 가 LB 서브넷 대역을 허용해야 한다(1단계 참고)
7. 헬스체크 경로는 `/health` 로 둔다. DB 연결까지 확인하므로 DB 가 끊긴 인스턴스는 자동으로 빠진다

#### HTTPS 를 쓰지 않는다

도메인을 확보하지 못했고, 인증서는 도메인 없이 붙일 수 없다. LB 리스너를 HTTP 로 둔다.

코드는 손댈 것이 없다. https 강제, secure 쿠키, HSTS 가 모두 없고 `FRONTEND_URL` 에
스킴 검증도 없다. 토큰은 쿠키가 아니라 `sessionStorage` 에 둔다.

**실서비스라면 이대로 두지 않는다.** 평문이라 토큰과 사진 URL 이 경로에서 그대로 보인다.
도메인을 확보하는 즉시 LB 에 인증서를 붙이고 `FRONTEND_URL`·`API_BASE_URL` 을 https 로 바꾼다.

---

## 4. Auto Scaling 과 관측

### 실제로 만든 것

```
Launch Configuration  kkagung-lc
                        서버 이미지   kkagung-app-base
                        Init Script  kkagung-app-init

Auto Scaling Group    kkagung-asg
                        최소 1 / 기대 2 / 최대 4
                        Target Group  kkagung-tg-api + kkagung-tg-web
                        헬스체크       로드밸런서 · 보류 300초 · 상세 모니터링 Y

정책                  scale-out  +1  쿨다운 300초
                      scale-in   -1  쿨다운 600초

Cloud Insight         kkagung-asg-cpu-high   avg_cpu_used_rto >= 60  AVG 5분   → scale-out
                      kkagung-asg-cpu-low    avg_cpu_used_rto <= 30  AVG 10분  → scale-in
```

ASG 는 Target Group 을 여러 개 받는다. API(8080)와 프론트(5173)를 한 그룹이 함께 채운다.

증설 경로가 실제로 도는 것을 확인했다. ASG 가 서버를 만들고, Init Script 가 레지스트리에서
이미지 두 개를 받아 컨테이너를 띄우고, Target Group 에 자동으로 붙는다. 사람 손이 들어가지 않는다.

**보류 기간(health check grace period)은 300초가 맞다.** 실제로 2분 남짓 걸린다. 서버가 뜨고,
Docker 가 레지스트리에서 두 이미지를 받고, `/health` 가 DB 연결까지 확인해야 끝난다.
180초로 두면 아슬아슬하고, 모자라면 멀쩡한 서버를 비정상으로 보고 반납했다가 다시 만드는
일이 반복된다.

### 이미지를 바꿀 때 LC 를 다시 만들지 않아도 된다

LC 가 가리키는 것은 **서버 이미지와 Init Script 둘뿐**이다. `APP_IMAGE`·`FRONTEND_IMAGE` 는
Init Script 본문 안에 있다. 그래서 **스크립트 두 줄만 고치면 다음에 뜨는 서버부터 새 이미지를**
**받는다.** LC 도 ASG 도 건드리지 않는다.

3단계에서 "확인될 때까지는 스크립트도 LC 도 새로 만든다" 로 적어 두었던 것을 여기서 줄인다.
LC 는 스크립트를 참조로 들고 있다. 실제로 수정한 뒤 증설시켜 확인했다.

앱 이미지를 서버 이미지에 굽지 않고 기동할 때 받기로 한 결정(D-05)이 여기서 값을 한다.
구웠다면 이미지를 바꿀 때마다 서버 이미지를 다시 만들고 LC 도 다시 만들어야 했다.

```
새 이미지 push → Init Script 의 APP_IMAGE·FRONTEND_IMAGE 수정 → 서버를 굴려 교체
```

### 서버를 굴려 교체하는 법

Init Script 는 기동할 때 한 번만 돈다. 이미 떠 있는 서버는 스크립트를 고쳐도 그대로다.
새 내용으로 바꾸려면 서버를 다시 만들어야 하는데, 서비스를 끊지 않고 할 수 있다.

```
기대 용량을 올려 새 서버를 먼저 띄운다 → Target Group 에 붙는 것을 확인 → 옛 서버를 반납
```

`TRUST_PROXY` 를 측정용으로 바꿀 때도 같은 방법을 쓴다(5절 참고).

---

## 5. 부하 테스트

도구는 `infra/loadtest/` 에 있다. **DB 를 쓰는 일과 HTTP 를 때리는 일을 나눠서 돌린다.**
Cloud DB 는 비공인 서브넷에 있고 계정 호스트가 앱 서브넷 대역으로 묶여 있어,
작업자 PC 에서는 DB 에 붙을 수 없다(2단계 참고). 반대로 측정은 LB 바깥에서 해야
실제 경로를 재는 것이 된다. 앱 서버에서 때리면 애플리케이션과 CPU 를 나눠 쓰게 된다.

### 1단계 — 앱 서버 안에서 (DB 작업)

마이그레이션과 같은 자리다. 징검다리를 거쳐 앱 서버로 들어간 뒤, 앱 이미지에
스크립트를 넣어 돌린다. 이미지에는 `loadtest/` 가 들어 있지 않으므로 올려서 붙인다.

```bash
# 부하용 계정 생성. @kkagung.load 도메인만 쓰므로 기능 시드와 섞이지 않는다.
docker run --rm -v "$PWD/loadtest:/app/loadtest" -e DATABASE_URL="$DATABASE_URL" -e ALLOW_REMOTE_LOAD_SEED=true \
  <이미지> node loadtest/seed-load.mjs --count 2000

# 당일 데이터를 비우고 토큰을 미리 발급해 파일로 뽑는다
docker run --rm -v "$PWD/loadtest:/app/loadtest" -e DATABASE_URL="$DATABASE_URL" -e JWT_SECRET="$JWT_SECRET" \
  -e ALLOW_REMOTE_LOAD_SEED=true <이미지> node loadtest/run-load.mjs --export loadtest/tokens.json --users 500 --reset
```

`--reset` 이 하는 일은 두 가지다. 부하용 계정의 운세·추천·새로고침권을 지우고,
**선착순 재고를 남은 티켓 수에 맞춰 다시 센다.** 재고를 되돌리지 않으면 두 번째
실행부터 바닥난 상태로 시작해 "설정한 개수만 발급됐는가" 를 확인할 수 없다.

### 2단계 — 작업자 PC 에서 (측정)

뽑은 파일만 가져오면 된다. **DB 접속도 `JWT_SECRET` 도 필요 없다.**

```bash
node infra/loadtest/run-load.mjs --base http://<LB 주소> --tokens-file tokens.json --concurrency 50
```

토큰 수명은 1시간이다. 파일에 유효한 토큰 500개가 들어 있으므로 쓰고 지운다.
저장소에는 커밋하지 않는다(`.gitignore` 에 넣어 두었다).

### 3단계 — 정리 (데모 전에 반드시)

**부하용 계정을 지우지 않으면 데모에 그대로 나온다.** 이 계정들은 프로필과 공개 이미지
행을 갖춘 정상 사용자라 추천 후보에 그대로 들어간다. 실제로 2,000개를 만든 뒤 추천을
받아 보니 다섯 장이 전부 `부하1071`·`부하1123` 이었다.

사진도 깨진다. 부하 시더는 행만 만들고 객체는 올리지 않는다(부하 시나리오가 이미지를
받지 않으므로 2,000개를 올릴 이유가 없다). 화면은 자리 표시로 떨어지지만 카드에 사람이
없는 것은 마찬가지다.

마지막 측정을 마친 뒤에 지운다. 측정을 다시 할 생각이면 그 전에 지우지 않는다.

```bash
docker run --rm -v "$PWD/loadtest:/app/loadtest" -e DATABASE_URL="$DATABASE_URL" -e ALLOW_REMOTE_LOAD_SEED=true \
  <이미지> node loadtest/seed-load.mjs --clean
```

`ALLOW_REMOTE_LOAD_SEED=true` 는 원격 DB 에 쓰기 위한 명시적 허용이다.
실수로 운영 DB 를 상대로 돌리지 않도록 둔 장치이고, 두 스크립트 모두 같은 기준을 쓴다.

### 429 가 섞이면 측정이 아니다

속도 제한이 IP 당 60초에 90회다. 스크립트는 사용자마다 다른 `X-Forwarded-For` 를
보내 이를 피하는데, **서버에 `TRUST_PROXY` 가 없으면 그 헤더가 무시되어 전부 한 IP 로
집계된다.** 그러면 대부분이 429 로 떨어지고 숫자는 의미가 없어진다.

**NCP ALB 는 이 헤더를 덮어쓰지 않고 덧붙인다.** 측정으로 확인했다. 그래서 서버가 보는
값은 `<도구가 넣은 가짜 IP>, <작업자 공인 IP>` 가 된다.

Express 의 trust proxy 는 오른쪽(서버 쪽)부터 신뢰 홉 수만큼 벗기고 남은 가장 바깥
주소를 `req.ip` 로 쓴다. 그래서 **운영값인 `TRUST_PROXY=1` 에서는 한 겹만 벗겨져 작업자**
**실제 IP 가 잡히고, 가짜 IP 는 무시된다.** 첫 측정에서 1,000건 중 900건이 429 였고 성공이
정확히 90건이었다. `api-ip` 한도(60초 90회) 한 바구니로 전부 집계된 것이다.

측정 동안만 `TRUST_PROXY=2` 로 둔다. 한 겹 더 벗겨져 가짜 IP 가 잡힌다.

**운영에서는 반드시 `1` 이다.** `2` 로 두면 클라이언트가 헤더를 한 겹 위조해 속도 제한을
우회할 수 있다. 서버를 재생성하면 Init Script 값인 `1` 로 돌아온다. 측정값을 적을 때는
`TRUST_PROXY=2` 로 쟀다는 것을 함께 적는다. 그 조건에서는 속도 제한이 운영과 같은
방식으로 걸리지 않으므로, 응답 시간은 유효하지만 제한 동작은 검증된 것이 아니다.

스크립트가 응답 코드에 429 가 섞이면 끝에 알려 준다.

### NCP 측정값 (2026-10-28)

조건: `kkagung-api:a1dc1d2`, 앱 서버 `s2-g3a` **한 대**, 사용자 500명 / 동시 50, LB 경유.

| | |
|---|---|
| `daily/open` | p50 3,423ms · p95 4,392ms · p99 4,431ms (성공 500/500) |
| `recommendations` | p50 800ms · p95 2,846ms · p99 3,302ms (성공 500/500) |
| 처리량 | 초당 25건 (총 40.5초, 1,000건) |

**측정은 `TRUST_PROXY=2` 로 했다. 운영 설정은 `1` 이다.** 아래 "429 가 섞이면" 참고.

#### 느린 원인은 자원 포화다. DB 도 네트워크도 아니다

부하 없이 단건으로 재면 `recommendations` 가 45~77ms, 연결에 20~50ms 다.
요청 하나는 50ms 내외인데 **동시 50개에서 p95 가 2.8초**가 된다.
Node 가 단일 스레드라 컨테이너 하나가 사실상 코어 하나만 쓰는 구간이다.

수직 증설로는 한계가 있고 **수평 증설이 맞는 그림이다.** 4단계 Auto Scaling 의 근거가
여기서 나온다. 증설 후 같은 조건으로 다시 재서 비교한다.

### 로컬 기준값 (노트북 한 대에서 DB·API 동시 구동)

사용자 2,000명 / 동시 30

| | |
|---|---|
| `daily/open` | p50 1,851ms · p95 2,405ms |
| `recommendations` | p50 278ms |
| 처리량 | 초당 25건 |

NCP 에서는 DB 가 분리되고 서버가 늘어나므로 이 값보다 나아야 한다. 그렇지 않으면 구성 문제를 먼저 의심한다.

이 값은 `TRUST_PROXY` 가 켜진 상태에서만 재현된다. 재현되지 않으면 그것부터 확인한다.
참고로 같은 노트북에서 사용자 300명 / 동시 30 은 `daily/open` p50 502ms · 초당 82건이었다.

### 확인할 것

- 8시 동시 접속에서 응답 시간과 오류율
- **선착순 새로고침권이 설정한 개수만 발급됐는지** DB 로 확인
- Auto Scaling 이 실제로 증설·축소하는지
- 인스턴스를 강제 종료했을 때 LB 가 빼고 재생성되는지
- 수락 전 원본 사진 접근이 거부되는지
- DB 시점 복원

---

## 시연용 데이터 넣기

**부하 측정을 모두 마친 뒤에 한다.** 부하용 계정 2,000개가 남아 있으면 추천 카드가
`부하NNNN` 으로 채워져 시연용 사람들이 묻힌다.

```
5단계 측정 끝  →  seed-load.mjs --clean  →  seed-demo.mjs  →  확인
```

스크립트는 앱 이미지에 들어 있지 않다. 돌고 있는 컨테이너에 넣어 `docker exec` 로 실행한다.
그러면 컨테이너의 `DATABASE_URL`·`OBJECT_STORAGE_*` 를 그대로 물려받는다.
`docker run` 에 환경변수를 다시 적는 방식은 하나만 빠뜨려도 사진 없이 계정만 생기므로 쓰지 않는다.

```bash
# 앱 서버에서 (징검다리를 거쳐 들어간다)
curl -fsSL -o seed-demo.mjs \
  https://raw.githubusercontent.com/philipn337-namphil/kkagung/main/infra/demo/seed-demo.mjs
docker cp seed-demo.mjs kkagung-api:/app/demo/seed-demo.mjs
docker exec kkagung-api node demo/seed-demo.mjs
```

`/app/demo/` 가 없으면 먼저 만든다(`docker exec kkagung-api mkdir -p /app/demo`).
같은 방법으로 부하 스크립트도 넣는다.

### 넣고 나서 확인할 것

`narae@kkagung.demo` / `kkagung123!` 로 로그인해서 본다. 관리자는 `unjeong@kkagung.demo` 다.

| | |
|---|---|
| 추천 카드 | `용산구 · 사슴상 28` 처럼 **이름 없이** 나오는가 |
| 카드 사진 | 흐림본이 보이는가 (403 이면 `OBJECT_STORAGE_*` 가 빠진 것이다) |
| 받은 관심 | 하트 3개, 채팅 요청 2개가 있는가 |
| 채팅방 | 이름과 **선명한 원본 사진**이 나오는가 |

시드는 같은 object key 에 덮어쓰므로 다시 돌려도 중복이 생기지 않는다.

## 제출물 묶기

`git archive` 로 만든다. 추적되는 파일만 들어가므로 `.env`·`node_modules`·`dist`·
부하 테스트 토큰 파일이 자동으로 빠진다. 작업 트리에 남은 임시 파일도 섞이지 않는다.

```bash
git switch main && git pull
git archive --format=zip -o kkagung.zip HEAD
```

묶기 전에 `develop` 을 `main` 으로 올렸는지 확인한다. 채점자가 보는 것은 `main` 이다.

### 묶은 뒤 확인

```bash
# 비밀값·사진·덤프가 섞이지 않았는지
unzip -l kkagung.zip | grep -iE ".env$|node_modules|/dist/|tokens.*json|dump"

# 받은 사람이 바로 띄울 수 있는지 (README 의 빠른 실행과 같은 경로)
unzip -l kkagung.zip | grep -E "README.md|infra/docker-compose.yml|.env.example"
```

## 배포 점검표

- [ ] `TRUST_PROXY` 를 지정했는가 (빠뜨리면 전원 429)
- [ ] 부하 측정이 끝난 뒤 `TRUST_PROXY` 가 운영값 `1` 로 돌아왔는가 (`2` 면 제한을 우회할 수 있다)
- [ ] `RUN_MIGRATIONS_ON_START=false` 인가
- [ ] 마이그레이션을 배포 단계에서 한 번 적용했는가 (빈 DB 여도 `/health` 는 통과한다)
- [ ] 마이그레이션용으로 연 징검다리→앱 서버 SSH 규칙을 닫았는가
- [ ] `JWT_SECRET` 이 이미지·저장소·로그에 남지 않는가
- [ ] 원본 버킷이 비공개인가
- [ ] 두 버킷 모두 전체 공개가 **"공개 안함"** 인가 (버킷 공개 = 목록 공개다)
- [ ] 제출 전 `develop` 을 `main` 으로 올렸는가
- [ ] 사진을 한 장 올려, 흐림본은 익명으로 열리고 원본은 403 인지 확인했는가
- [ ] 앱 서브넷에 NAT Gateway 경로가 있고, DB 서브넷에는 없는가
- [ ] `kkagung-acg-app` 의 **아웃바운드**가 열려 있는가 (비면 `docker pull` 이 타임아웃난다)
- [ ] 레지스트리 저장 버킷이 `kkagung-registry` 인가 (사진 버킷이 아니어야 한다)
- [ ] 서버 이미지를 만들 때 쓴 임시 서버·공인 IP·서브넷·ACG 를 반납했는가
- [ ] **부하용 계정을 지웠는가** (`seed-load.mjs --clean`). 남아 있으면 추천 카드에 `부하NNNN` 이 나온다
- [ ] 시연용 시드를 넣고 추천 카드에 이름이 없는지·사진이 보이는지 확인했는가
- [ ] `FRONTEND_URL` 이 브라우저가 보는 주소와 **정확히** 같은가 (CORS 는 Origin 하나만 받는다)
- [ ] LB 경로 규칙이 `/api/*` 를 8080 으로, 나머지를 5173 으로 보내는가
- [ ] `/health` 가 LB 헬스체크에 연결됐는가
- [ ] Target 상태가 `DOWN` · `TCP TIMEOUT` 이면 앱 ACG 의 출발지를 의심한다 (LB 는 ACG 를 못 가진다)
- [ ] `DATABASE_URL` 비밀번호의 특수문자를 퍼센트 인코딩했는가
- [ ] `APP_IMAGE` 태그가 `latest` 가 아니라 커밋을 가리키는가
- [ ] 값이 채워진 Init Script 를 저장소에 커밋하지 않았는가 (저장소 파일은 빈 템플릿이어야 한다)
- [ ] `ADMIN_ALLOWED_IP_CIDRS` 를 지정했는가 (비우면 관리자 API 전부 403. `/health` 는 정상이라 늦게 발견된다)
