# PR #38 병합 후 재검증

대상: develop `70fc9e3`(PR #38)와 보안 PR #37을 통합한 보안 feature 브랜치. 업로드·운영 문서 수정을 merge한 뒤 사용자 합의 범위에서 `chatRooms.ts`의 수락 후 원본 발급을 구현하고 API 문서를 갱신했다. DB 스키마 변경은 없다.

## 확인한 결과

- 이전 실패가 있던 dev·trustProxy·images 세 파일을 선택 실행: **31 통과·0 실패·0 대기**. 전체 백엔드를 재실행한 결과와 구분한다.
- Windows의 SDK 초기 로딩을 고려해 선택 실행에만 개별 60초·worker 1개를 적용했다. 응답·데이터 기대 조건은 변경하지 않았다. 이전 3건은 이 조건에서 재현되지 않았으며 모든 환경의 전송·시간 문제가 해결됐다는 뜻은 아니다.
- 사진/정지/탈퇴 시험: **8/8 통과**. IMG-01은 **202/409**, 원본 DB 3개, slot 3 원본 1개, DB 미참조 객체 **private 0 / public 0**.
- 실제 관리자·차단·미신뢰 전달 헤더 거부: **7/7 통과**.
- 상대 원본 발급 구현 후 사진·권한·상태: **12/12 통과**, 기존 채팅방 회귀도 별도 **12/12 통과**. 수락된 양 참여자의 실제 원본 다운로드, 최대 60초·no-store·제3자/관리자 거부, 수락 전·거절·무시와 양방향 차단·정지·탈퇴를 검증했다.
- 실제 MySQL 20개 테이블 덤프·복원: 건수와 PK순 논리 데이터 덤프의 **SHA-256 일치**. 임시 DB와 Moto 서버 종료 확인. 사진/NAS·운영 RPO/RTO는 아님.
- OPS-01: 배포 문서의 빈 허용 IP 설명이 실제 운영 403과 일치하도록 수정됐고, init script도 비어 있는 값을 거부한다. 실제 NCP ACG·LB 설정 검증을 대신하지 않는다.
- 원본 참여자·업로드 자리표시자 2개를 실행된 통합 시험으로 옮겼다. 주요 회귀는 빌드 PASS, **86개 중 84 통과·0 실패·2 대기**다. 남은 skip은 전체 권한/상태 조합과 DB·객체·NAS 운영 복구다. 실제 NCP 버킷 ACL·서명 만료 검증은 별도이며 이 수치로 완료 처리하지 않는다.

증빙은 `portable-db-recheck.json`, `storage-recheck.json`, 최신 `live-image-state-audit.json`, `live-db-audit.json`이다. 수정 전 사진 실패는 `live-image-state-before-pr38.json`, 이전 전체 결과 141/144는 `portable-db-drill.json`에 보존한다. 서로 다른 묶음은 합산하지 않는다.

원본 발급을 추가한 재검증에서는 native CHECKSUM TABLE이 NULL을 반환해 `unsupported-checksum`으로 실패했다. 해당 결과는 `portable-db-native-checksum-failure.json`에 보존했다. 정렬한 전체 논리 행의 SHA-256과 테이블 건수를 양 DB에서 다시 비교해 일치했으며, 그 최종 복구 결과는 `portable-db-focused.json`이다. 댓글·덤프 시각·DDL을 제외하고 PK 순으로 출력한 행을 비교한다. 원문 덤프는 파일/Git에 남기지 않는다. `--focused`는 전체 백엔드를 생략하므로 정상이어도 종료 3이며, 전체 통과와 구분한다.

실행: `node infra/security/run-storage-gates.mjs <mysqlHome> <python> <motoPackages> --recheck`. 이 옵션은 위 세 테스트 파일만 실행하고 별도 결과 파일을 기록한다.

## 실제 NCP 검증 준비

현재 연결 도구와 로컬 환경 파일에서 실행 가능한 실제 NCP 테스트 설정은 확인되지 않았다. `ncp-storage-check.mjs`를 작성하고 로컬 사전 검사 5개를 통과했다. 실제 provider 호출은 미실행이다.

기존 테스트 전용 버킷 두 개를 사용한다. 이름은 `kkagung-test-*`, `kkagung-staging-*`, `kkagung-security-*` 중 하나여야 하며 서로 달라야 한다. 운영 환경 플래그·TLS 검증 해제·HTTP·URL 내 자격증명은 거부한다. 버킷이나 정책은 생성/변경하지 않고 고유 테스트 prefix에 가상 텍스트 두 개만 생성한다. 익명 원본/목록 거부, 공개 객체 읽기, 정상 서명 읽기, 변조·만료 서명 거부를 검사하고 자신이 만든 정확한 두 key만 삭제한다. URL·서명·자격증명·객체 key 원문은 증빙에 기록하지 않는다.

실행 환경에 OBJECT_STORAGE_ENDPOINT/REGION/BUCKET_PRIVATE/BUCKET_PUBLIC/ACCESS_KEY/SECRET_KEY를 안전하게 주입한다. 비밀값은 채팅·Git에 넣지 않는다.

```powershell
# 기본 모드는 미리보기이며 네트워크 접근이 없다.
node infra/security/ncp-storage-check.mjs --plan
# 실제 테스트 자원이 준비된 경우에만 환경에서 명시한다.
$env:SECURITY_STORAGE_TEST_RESOURCES='true'
node infra/security/ncp-storage-check.mjs --run
```

`--run` 구현 자체는 실제 NCP에서 실행 검증되지 않았다. 사전 검사 통과나 모형 결과를 NCP 통과로 집계하지 않는다. 사진/NAS 백업의 실제 복원·삭제 이력 대조·운영 RPO/RTO 역시 미완료다.

## 수락 후 상대 원본 발급 구현

GET `/api/v1/chat-rooms/:roomId`가 아래 규칙에 따라 상대의 원본 URL을 반환하도록 구현했다.

1. 현재 토큰·DB 계정과 채팅방 참여자 자격을 확인한다. 제3자·없는 방은 기존 403/404 정책을 유지한다.
2. 요청이 ACCEPTED인 방에서만 상대 원본을 발급한다. 수락 전·거절·무시에는 발급하지 않는다.
3. 양방향 차단 또는 어느 당사자의 SUSPENDED/WITHDRAWN 상태면 새 URL을 만들지 않는다.
4. ORIGINAL_PRIVATE/DONE인 상대 이미지에 서버가 만든 URL만 사용한다. 수명은 최대 60초, 응답은 no-store, 별도 object key 필드는 금지한다.
5. 저장소가 준비되지 않았거나 원본이 없으면 기존 빈 배열 동작을 유지한다. 이미 발급한 URL은 명세대로 만료까지 유효할 수 있다.
6. 실제 사용자 권한·수락·차단·정지·탈퇴와 서명 URL/원본 메타데이터를 검증하고 API 문서를 함께 갱신한다. 스키마 변경 없이 구현 가능한 범위다.

수정 범위는 승인된 `backend/src/routes/chatRooms.ts`, `docs/03_API_명세서.md`, 보안 테스트로 제한했다. CHAT_RESTRICTED는 기존 명세의 메시지 전송 제한이며 사진 읽기와 분리했다. 실제 NCP 서명 URL 변조/만료·버킷 정책은 아직 실행하지 않아 로컬 모형 결과와 분리한다.
