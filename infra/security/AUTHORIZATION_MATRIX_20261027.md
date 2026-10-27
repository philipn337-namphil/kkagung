# 권한·계정 상태 조합 검증

## 최종 결과

**75개 상황 × 7개 검사 + 프로필/선호 조건 2개 + 제3자/비참여자 관리자 8개 + 관리자 역할·상태 10개 = 545 통과·0 실패.** `authorization-matrix.json`의 failed 배열은 비어 있다. 제품 코드 수정 없이 검증·도구·보고서만 변경했다.

`portable-db-matrix.json`: 빌드·마이그레이션·시드·조합 검사·20개 테이블 복원 통과. 양 DB의 건수와 PK순 논리 행 SHA-256이 일치했다. MySQL과 Moto 모두 종료됐다. `focused-only`는 전체 백엔드를 실행하지 않았다는 의미이며 보안 실패가 아니다. 기존 사진 12/12·채팅방 12/12·관리자/차단 7/7 결과는 별도 묶음으로 유지한다.

최종 주요 회귀는 **빌드 PASS, 85개 중 84 통과·0 실패·1 대기**다. 조합 자리표시자를 실제 DB 시험으로 옮겼으며 남은 skip은 DB·객체·NAS의 운영 복구/RPO/RTO다. 실제 NCP 검증은 별도 대기이며 skip 수만으로 운영 준비 완료를 판단하지 않는다. 스키마 비교 보조 시험은 별도 **4/4 통과**했다. 서로 다른 묶음은 합산하지 않는다.

## 범위와 정책

develop `70fc9e3` + 원본 발급 구현 `7ceb55e`를 기준으로 보안 검증 도구만 추가한다. 제품 코드·API·DB 스키마 변경은 없다.

실제 HTTP와 새로 생성한 격리 MySQL을 사용한다. 계정 상태는 ACTIVE, RECOMMENDATION_BLOCKED, CHAT_RESTRICTED, SUSPENDED, WITHDRAWN이다. 요청자 5종 × 상대 5종 × 차단 없음/요청자가 차단/상대가 차단의 **75개 상황**을 검사한다. 상태 변경 전에 발급한 같은 토큰을 사용해 현재 DB 상태를 반영하는지도 확인한다.

| 동작 | 허용되는 요청자 상태 | 허용되는 상대 상태 | 양방향 차단 중 하나라도 있으면 |
|---|---|---|---|
| 추천에 상대 노출·카드 조회·하트 | ACTIVE, RECOMMENDATION_BLOCKED, CHAT_RESTRICTED | ACTIVE, CHAT_RESTRICTED | 제외·거부 |
| 새 채팅 요청·받은 요청 수락 | ACTIVE, RECOMMENDATION_BLOCKED | ACTIVE | 거부 |
| 기존 방 신규 메시지 | ACTIVE, RECOMMENDATION_BLOCKED | ACTIVE, RECOMMENDATION_BLOCKED, CHAT_RESTRICTED | 거부 |
| 수락된 방의 상대 원본 URL | ACTIVE, RECOMMENDATION_BLOCKED, CHAT_RESTRICTED | ACTIVE, RECOMMENDATION_BLOCKED, CHAT_RESTRICTED | 발급하지 않음 |

SUSPENDED/WITHDRAWN 요청자는 인증 미들웨어에서 403이다. 관리자 API는 **현재 DB의 ADMIN + ACTIVE**만 허용한다. ADMIN 토큰 발급 후 USER로 변경해도 403이어야 한다. 위 정책은 라우트 응답에서 기대값을 계산하지 않고 테스트에 별도로 고정했다.

각 상황에서 7개 동작을 검사한다. 하트·요청·수락·메시지는 응답과 DB 행 수/상태를 함께 확인한다. 수락은 방과 참여자 2명이 함께 만들어져야 한다. 사진은 URL 발급 여부·60초·no-store를 확인하며 실제 파일 다운로드는 기존 별도 사진 시험에서 수행한다.

추가로 프로필/선호 조건의 userId 주입, 제3자·비참여자 관리자의 방/메시지 접근·전송·타인 요청 수락, 역할 2종 × 상태 5종을 검사한다. 이 문서의 '조합'은 나열한 차원의 유한한 범위이며 모든 동시성·시간 경계·운영 인프라까지 전수 검증했다는 뜻이 아니다.

## 실행과 증빙

```powershell
node infra/security/run-storage-gates.mjs <mysqlHome> <python> <motoPackages> --focused
# 조합 검사만 다시 실행 (기존 관리자·사진 결과는 덮어쓰지 않음)
node infra/security/run-storage-gates.mjs <mysqlHome> <python> <motoPackages> --matrix
```

이 명령은 새 임시 DB와 루프백 Moto S3 모형을 준비하고 기존 관리자/차단·사진 시험과 조합 검증을 순서대로 실행한다. DB 주소·사용자·무작위 실행 ID가 격리 실행기의 형식과 다르면 조합 도구는 실행을 거부한다. 앞선 시험의 같은 가상 사용자 쌍 요청은 정리해 긍정 조건을 보장한다. 속도 제한 카운터 초기화도 이 임시 DB 안에서만 수행한다.

`--focused`는 전체 백엔드 시험을 생략하므로 정상 완료도 종료 코드 3이다. 실제 시험 실패는 증빙의 steps와 failed 배열로 구분한다. URL·JWT·사진·비밀번호·덤프 원문을 증빙에 남기지 않는다.

- 조합 상세: `evidence/authorization-matrix.json`
- 조합 단독 실행 단계·DB 복원/종료: `evidence/portable-db-matrix.json`
- 조합 단독 모형 종료: `evidence/storage-matrix.json`
- 앞선 기존 시험까지 포함한 실행: `portable-db-focused.json`, `storage-focused.json`
- 실제 운영에서 남은 검증: NCP ACL·서명 변조/만료·LB/ACG, 사진/NAS 복원·운영 RPO/RTO

첫 시도는 샌드박스의 루프백 EACCES로 서버 준비가 실패했고, 다음 시도는 Prisma Client 생성 시간 초과로 중단됐다. 해당 시도는 통과로 집계하지 않았다. 권한 조정과 클라이언트 재생성 후 다시 실행했다. Prisma가 공백뿐 아니라 모델 속성 순서도 바꿀 수 있으므로, 안전한 토큰 동일성 검사가 다르면 재생성한다. 필드 변경을 무시하도록 완화하지 않는다.

최초 조합 검사는 543 통과·2 실패였다. 두 실패는 타인 요청 수락에 404를 기대했던 테스트 오류다. API 명세의 수신자 아님 오류는 FORBIDDEN 403이며 구현도 일치한다. 제품 코드는 변경하지 않았다. 최초 결과는 `authorization-matrix-initial-expectation-failure.json`에 보존했다. 이때 관리자·차단 7/7, 사진 12/12, 기존 채팅방 12/12와 DB 20개 테이블 복원은 통과했으며, 조합 실패 때문에 전체 실행은 failed-tests로 남아 있다. 재실행 결과와 구분한다.

그 뒤 마이그레이션 ETIMEDOUT으로 시험 시작 전에 중단된 단독 실행은 `authorization-matrix-runner-timeout.json`에 보존했다. 주요 회귀 실행에서도 결과 JSON이 생성되지 않은 시도가 있어 통과로 집계하지 않고 단독 재실행했다. 중단 시도의 원인을 제품 권한 오류로 확정하지 않는다.
