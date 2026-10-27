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
| Subnet | `kkagung-sn-nat` | `10.0.2.0/24` | NAT Gateway 전용, 공인 |
| NAT Gateway | `kkagung-natgw` | | 공인 IP 할당 |

실제로 만든 자원은 아래와 같다. 이후 단계에서 이 이름으로 지정한다.

```
VPC     kkagung-vpc         151444
Subnet  kkagung-sn-lb       332078   10.0.1.0/24    공인   LoadBalancer
        kkagung-sn-app      332079   10.0.10.0/24   사설   일반
        kkagung-sn-db       332080   10.0.20.0/24   사설   일반
        kkagung-sn-nat      332184   10.0.2.0/24    공인   NatGateway
ACG     kkagung-acg-lb      411093
        kkagung-acg-app     411094
        kkagung-acg-db      411095   (미사용)
        cloud-mysql-2f8r8p  411098   Cloud DB 가 자동 생성
NATGW   kkagung-natgw                공인 IP 211.233.206.191 / 사설 10.0.2.6
```

`kkagung-acg-db` 는 Cloud DB 가 전용 ACG 를 따로 만들기 때문에 쓰이지 않는다. 2단계를 참고한다.

ACG 는 IP 대역이 아니라 **다른 ACG 를 출발지로** 지정한다. 서버가 늘어도 규칙을 고치지 않기 위해서다.

| ACG | 인바운드 허용 |
|---|---|
| `kkagung-acg-lb` | 인터넷 → 443 |
| `kkagung-acg-app` | `kkagung-acg-lb` → 8080 |
| `kkagung-acg-db` | `kkagung-acg-app` → 3306 |

NACL 은 서브넷 단위로 위 경로 외의 인·아웃바운드를 차단한다.

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

### 순서

1. Container Registry 에 레지스트리를 만들고 위 명령으로 이미지를 올린다
2. 서버 이미지에 Docker 를 설치해 둔다. 애플리케이션 이미지는 넣지 않는다
3. 서버는 `kkagung-sn-app` 에 만들고 ACG 는 `kkagung-acg-app` 을 붙인다
4. Init Script 를 먼저 콘솔에 등록하고(서버 생성 화면에서 고르려면 미리 있어야 한다),
   서버 설정 단계에서 그 스크립트를 고른다 — `infra/ncp/init-script.sh`
   - 등록할 때 상단 블록의 큰따옴표 안을 채운다. 채운 사본은 콘솔에만 둔다
   - 필수 값이 없으면 기동 전에 멈춘다. 조용히 잘못된 설정으로 뜨는 것을 막는다
   - 레지스트리 비밀번호는 표준입력으로 넘긴다. 인자로 주면 `ps` 출력에 그대로 보인다
   - 받아오기를 먼저 하고 기존 컨테이너를 지운다. 반대로 하면 `pull` 이 실패했을 때
     되돌릴 것 없이 서비스만 내려간다
   - 끝나면 `docker logout` 한다. 자격증명이 인스턴스의 `~/.docker/config.json` 에 남는다
   - `TRUST_PROXY` 기본 `1`, `RUN_MIGRATIONS_ON_START` 는 `false` 로 고정
   - 기동 후 `/health` 가 통과할 때까지 기다린다. 실패하면 컨테이너 로그를 남기고 종료한다
5. Load Balancer 를 `kkagung-sn-lb` 에 만들고 HTTPS 리스너에 인증서를 붙인다
6. 헬스체크 경로는 `/health` 로 둔다. DB 연결까지 확인하므로 DB 가 끊긴 인스턴스는 자동으로 빠진다

---

## 4. Auto Scaling 과 관측

Launch Configuration 도 같은 Init Script 를 고른다. 3단계에서 값을 채워 등록해 둔 그 스크립트다.
증설된 서버는 그 스크립트대로 이미지를 받아 뜨므로, **배포할 때 바꿔야 하는 것은 스크립트 안의
`APP_IMAGE` 태그**다. 스크립트를 고친 뒤 Auto Scaling 이 새 내용을 쓰는지,
아니면 Launch Configuration 을 다시 만들어야 하는지는 콘솔에서 확인한다.

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
- [ ] 두 버킷 모두 전체 공개가 **"공개 안함"** 인가 (버킷 공개 = 목록 공개다)
- [ ] 사진을 한 장 올려, 흐림본은 익명으로 열리고 원본은 403 인지 확인했는가
- [ ] 앱 서브넷에 NAT Gateway 경로가 있고, DB 서브넷에는 없는가
- [ ] `FRONTEND_URL` 과 `API_BASE_URL` 이 HTTPS 도메인인가
- [ ] `/health` 가 LB 헬스체크에 연결됐는가
- [ ] `APP_IMAGE` 태그가 `latest` 가 아니라 커밋을 가리키는가
- [ ] 값이 채워진 Init Script 를 저장소에 커밋하지 않았는가 (저장소 파일은 빈 템플릿이어야 한다)
- [ ] `ADMIN_ALLOWED_IP_CIDRS` 를 지정했는가 (비우면 관리자 API 전부 403. `/health` 는 정상이라 늦게 발견된다)
