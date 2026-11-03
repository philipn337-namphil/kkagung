# 09. NCP 배포 기록 — 콘솔 화면

> 2026-10-26 ~ 10-28 에 NAVER Cloud Platform 에 실제로 배포해 운영한 화면을 남긴다.
> 교육용 계정이 **2026-11-09 에 정리되면서 자원이 모두 삭제**되므로, 그 전에 콘솔을 캡처했다(11-03).
> 왜 이렇게 구성했는지는 [05](05_NCP_아키텍처.md), 어떻게 올렸는지는 [07](07_NCP_배포_절차.md) 에 있다.

서비스 주소였던 `http://kkagung-lb-146561079-3d9bf41537a5.kr.lb.naverncp.com` 은 11-09 이후 열리지 않는다.

---

## 한눈에 — 부하가 서버를 늘리고 줄였다

10-28 부하 테스트 때 CPU 알람이 Auto Scaling 을 실제로 움직인 기록이다. 세 장의 시각이 맞물린다.

![부하 테스트 구간의 CPU 사용률](images/ncp/21-cloud-insight-cpu-load-test.png)

| 시각 (10-28) | 일어난 일 | 근거 |
|---|---|---|
| 17:03 | 부하 시작. 17:05 까지 CPU 가 0 에서 **87%** 로 오르고 그대로 이어진다 | 위 그래프 |
| **17:11** | `cpu-high`(≥ 60%, 5분 평균) 알람 → **scale-out, 기대 용량 1 → 2** | 아래 이력 |
| 17:13 무렵 | CPU 가 내려간다 | 위 그래프 |
| **17:24** | `cpu-low`(≤ 30%, 10분 평균) 알람 → **scale-in, 기대 용량 2 → 1** | 아래 이력 |

CPU 가 60% 를 넘은 상태가 5분 평균 조건을 채운 뒤 17:11 에 늘었고, 30% 아래로 내려간 상태가
10분 평균 조건을 채운 뒤 17:24 에 줄었다. **설정한 조건대로 동작했다.** 늘릴 때는 5분, 줄일 때는
10분으로 기간을 다르게 둔 것이 그대로 나타난다 — 몰릴 때는 빠르게 늘리고, 줄일 때는 서두르지 않는다.

![ASG 이력 — scale-out](images/ncp/22-asg-history-scale-out.png)

`At 2026-10-28T17:11:04+0900 a monitor alarm in state ALARM triggered policy scale-out changing the desired capacity from 1 to 2.`

![ASG 이력 — scale-in](images/ncp/23-asg-history-scale-in.png)

`At 2026-10-28T17:24:04+0900 a monitor alarm in state ALARM triggered policy scale-in changing the desired capacity from 2 to 1.`

사람이 손대지 않았다. 알람이 서버를 만들었고, Init Script 가 레지스트리에서 이미지를 받아 컨테이너를
띄웠고, Target Group 에 자동으로 붙었다. 처리량 실측(1대 초당 22건 → 4대 90건)은 [07 5절](07_NCP_배포_절차.md) 에 있다.

---

## 1. 네트워크

### VPC

![VPC](images/ncp/01-vpc.png)

`kkagung-vpc` · `10.0.0.0/16`. 함께 보이는 `lab-vpc` 는 같은 계정의 다른 실습 자원이다.

### Subnet

| 서브넷 | 대역 | 공인/사설 | 용도 |
|---|---|---|---|
| `kkagung-sn-lb` | 10.0.1.0/24 | 공인 | 로드밸런서 전용 |
| `kkagung-sn-nat` | 10.0.2.0/24 | 공인 | NAT Gateway 전용 |
| `kkagung-sn-app` | 10.0.10.0/24 | **사설** | 앱 서버 |
| `kkagung-sn-db` | 10.0.20.0/24 | **사설** | Cloud DB |
| `kkagung-sn-build` | 10.0.3.0/24 | 공인 | 서버 이미지 제작 · 징검다리 |

![서브넷 — LB](images/ncp/02-subnet-lb.png)

![서브넷 — 앱](images/ncp/03-subnet-app.png)

![서브넷 — DB](images/ncp/04-subnet-db.png)

![서브넷 — NAT](images/ncp/05-subnet-nat.png)

![서브넷 — 빌드](images/ncp/06-subnet-build.png)

### NAT Gateway와 Route Table

앱 서버가 바깥(Container Registry, Object Storage)으로 나가는 유일한 길이다. DB 서브넷은 이 경로에
연결하지 않아 **바깥으로 나가는 길이 없다.**

![NAT Gateway](images/ncp/07-nat-gateway.png)

![Route Table — 앱](images/ncp/08-route-table-app.png)

---

## 2. 접근 제어

### ACG

차단은 ACG 가 한다. NACL 은 기본값으로 두었다(이유는 [07](07_NCP_배포_절차.md)).

![ACG — 앱](images/ncp/09-acg-app.png)

앱 서버는 **LB 서브넷 대역(10.0.1.0/24)에서 오는 8080 · 5173** 만 받는다. NCP 의 로드밸런서는
관리형이라 ACG 를 출발지로 지정할 수 없어 대역을 직접 허용했다. 22 는 징검다리 ACG 에서만 연다.

![ACG — DB](images/ncp/10-acg-db.png)

DB 는 **앱 ACG 에서 오는 3306** 만 받는다. DB 계정도 접속 호스트를 `10.0.10.%` 로 묶어 두었다.

### 서버

![서버 목록](images/ncp/11-server-list.png)

앱 서버(`s-c5qg3wfnjh92j`)는 **비공인 IP `10.0.10.6` 만 있고 공인 IP 가 없다.** 들어오는 길은 LB
하나뿐이다. 아래 줄은 징검다리 서버다.

---

## 3. 로드밸런서

![Load Balancer](images/ncp/12-load-balancer.png)

Application Load Balancer, 공인, `kkagung-sn-lb` 에 둔다. 경로로 나눠 보낸다 — `/api/*` 는 8080,
나머지는 5173.

![Target Group — API](images/ncp/13-target-group-api.png)

![Target 상태 — API](images/ncp/14-target-status-api.png)

![Target Group — 웹](images/ncp/15-target-group-web.png)

![Target 상태 — 웹](images/ncp/16-target-status-web.png)

두 대상 그룹 모두 **UP · HTTP/200**. API 의 헬스체크는 `/health`(DB 연결까지 확인), 웹은 `/` 다.

---

## 4. Auto Scaling 구성

![Launch Configuration](images/ncp/17-launch-configuration.png)

서버 이미지 `kkagung-app-base` 와 Init Script 만 가리킨다. **앱은 서버 이미지에 굽지 않고, 서버가 뜰 때
레지스트리에서 받는다.** 그래서 새 버전을 올릴 때 Launch Configuration 을 다시 만들지 않는다.
(`webserver-lc` 는 다른 실습 자원이다.)

![Auto Scaling Group](images/ncp/18-asg-detail.png)

최소 1 / 기대 1 / 최대 4. 헬스체크는 로드밸런서 기준, 보류 300초. Target Group 두 개를 함께 채운다.

![Event Rule — cpu-high](images/ncp/19-event-rule-cpu-high.png)

![Event Rule — cpu-low](images/ncp/20-event-rule-cpu-low.png)

---

## 5. 데이터와 이미지 저장소

![Cloud DB for MySQL](images/ncp/24-cloud-db.png)

Master 와 **Standby Master** 두 대 — 고가용성. 사설 서브넷 `kkagung-sn-db` 에 있다.

![Object Storage](images/ncp/25-object-storage-buckets.png)

버킷 셋. **흐림 처리본은 `kkagung-images-public`, 원본은 자물쇠가 붙은 `kkagung-images-private`**, 그리고
컨테이너 이미지 저장소 `kkagung-registry`. 원본과 공개본을 버킷 단위로 나눠 "수락 전 원본 비노출" 을
구조로 보장한다(D-01).

![Container Registry](images/ncp/26-container-registry.png)

---

## 남기지 못한 것

- **Route Table 의 Routes 탭**, **LB 리스너 규칙**, **레지스트리 이미지 태그 목록**은 캡처하지 못했다.
  설정 내용은 [07](07_NCP_배포_절차.md) 에 글로 남아 있다
- **서비스 화면과 부하 테스트 영상**은 영상으로 따로 보관한다. 용량 때문에 저장소에는 넣지 않았다

## 공개 저장소라 가린 것

- 서버 목록의 징검다리 서버 공인 IP
- Event Rule 의 NRN 안에 있는 계정 번호
