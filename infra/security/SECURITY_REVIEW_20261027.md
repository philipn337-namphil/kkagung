# 병합 develop 사진·탈퇴·운영 보안 검증

## 대상과 경계

2026-10-27(KST), `develop` 5842e3c 기준 새 `feature/security-images-withdrawal`에서 검증한다. 기존 PR #21·#22, 프론트 API 계약, 업로드·탈퇴, 프록시·추천 처리 개선이 병합된 상태다. 앱·프론트·DB 스키마는 수정하지 않고 보안 테스트·실행 도구·보고서만 변경한다.

실제 로컬 MySQL 8.4.13과 실제 Sharp 이미지 처리, 실제 HTTP 라우트를 사용한다. 스토리지는 Moto 5.2.2의 S3 모형이다. MinIO 공식 실행 파일 다운로드가 HTTP 410으로 중단되어 모형으로 전환했다. 모형의 익명/서명 읽기 결과는 NCP 버킷 정책·서명 검증·만료의 실환경 증빙이 아니다. 실제 NCP 계정·키·사진은 사용하지 않는다.

## 실행과 증빙

```powershell
node infra/security/run-storage-gates.mjs <공식-MySQL-영문-설치경로> <python.exe> <moto-S3-패키지경로>
node infra/security/run-phase2.mjs
```

Moto 도구 의존성은 별도 Git 밖 폴더에 `pip install --target <폴더> 'moto[s3]==5.2.2' flask flask-cors`로 설치한다. 공식 서버 모드 설명: https://docs.getmoto.org/en/latest/docs/server_mode.html . 백엔드 의존성은 package-lock 기준 설치 후 Prisma Client를 생성한다. 실행 도구는 매번 새 DB와 임의 포트·가상 자격증명을 만들고 loopback으로만 연결한다. 공개 읽기 허용은 이번 모형 프로세스의 가상 공개 버킷에만 적용한다. private 버킷은 기본 비공개다. 모형·DB 서버는 종료하고 진단용 가상 데이터/비공개 오류 로그는 Git 밖에 둔다.

증빙: `evidence/phase2-results.json`(mock DB 회귀·바이트 처리), `portable-db-drill.json`(실제 DB·백엔드 테스트·복원), `live-db-audit.json`(관리자·차단·네트워크), `live-image-state-audit.json`(사진·상태 전이), `storage-gates.json`(모형과 정리). 서로 다른 시험 수를 합산하지 않는다. 실패를 skip/expected failure로 바꾸지 않는다.

## 추가한 검증

| 실행 묶음 | 결과 | 범위 |
|---|---|---|
| 주요 회귀·실제 이미지 처리 | 빌드 PASS, 88개 중 84 통과·0 실패·4 대기 | mock Prisma / 실제 HTTP·Sharp |
| 백엔드 전체 | 빌드 PASS, 144개 중 141 통과·3 실패·0 대기 | 실제 MySQL / Moto S3 모형 |
| 관리자·차단·헤더 위조 | 7/7 통과 | 실제 HTTP/JWT/MySQL |
| 강화한 사진·상태 전이 | 8개 중 7 통과·1 실패 | 실제 HTTP/MySQL/Sharp + Moto S3 |
| DB 덤프·복원 | 20개 테이블 건수·체크섬 일치 | 약 97초는 로컬 연습 시간이며 운영 RTO가 아님 |

백엔드 전체 실행 상한 180초에서는 결과 JSON이 없었고 서버 종료를 확인했다. 상한을 600초로 늘린 재실행에서 144개 결과를 수집했다. 실패와 별개로 개별 보안·복구 시험은 계속 실행되며 전체 성공으로 집계하지 않는다. `--focused` 옵션은 전체 테스트를 생략하고 별도 결과 파일을 남긴다. 이전 Client 스키마와 현재 스키마가 정확히 같을 때만 생성물을 재사용한다.

최종 별도 시험에서 10MiB 직상회 multipart와 압축된 20,005,000픽셀 multipart 모두 **413**이었다. 원본 메타데이터 제거·60초 서명 설정·타인 목록/삭제 차단, 정상 관계 대비 정지/탈퇴 시 실제 추천·받은 하트·채팅 목록 제외, 신규 하트·요청·메시지·사진 URL 거부, 실제 탈퇴의 사용 토큰 401/다른 토큰 403도 통과했다. 현재 채팅 상대 원본 성공 경로가 없는 점과 모형의 서명 만료 검증 한계는 유지한다.

전체 실행의 초기 사진 시나리오는 DB 수량만 검사해 202/500을 통과시켰다(`live-image-state-initial.json`). 최종 `live-image-state-audit.json`은 응답 202/409와 잔여 객체도 검사하여 7/8, IMG-01 실패로 판정했다. 초기 `portable-db-drill.json`의 image-state-audit=true를 최종 통과로 사용하면 안 된다. 강화 시험의 실행은 `portable-db-focused.json`, `storage-focused.json`에 별도로 남기며 전체 백엔드 141/144 결과는 보존한다.

- 실제 JPEG·PNG·WebP 수용 후 비공개 JPEG/공개 흐림 WebP로 정규화.
- 텍스트·HTML·SVG·GIF·손상 파일 거부, 빈 파일 400, 10MiB 초과·2천만 픽셀 초과 413.
- 원본·흐림본의 EXIF/ICC/XMP/IPTC 제거 및 EXIF 회전의 픽셀 반영. 이미지 처리 단독 11/11 통과.
- 파일명 경로를 무시한 서버 생성 object key, 원본 서명 URL의 60초 설정, 타인 목록/삭제 권한.
- 동시에 같은 slot 업로드 시 최대 3장·slot 유일성. 슬롯 조회 후 저장 사이 경쟁을 실제 HTTP로 검사.
- 정상 추천·하트·채팅 관계가 먼저 보이는지 확인한 뒤 SUSPENDED/WITHDRAWN 상태에서 실제 목록 제외·신규 하트/요청/메시지 거부·새 사진 URL 발급 거부.
- 실제 탈퇴 API 호출 후 사용 토큰 폐기와 다른 기존 토큰의 상태 기반 차단.
- TRUST_PROXY가 비어 있는 앱에서 X-Forwarded-For 위조가 관리자 IP 허용 목록을 충족시키지 못하는지 검사.

## 테스트 준비 문제의 처리

package-lock 재설치 후 Prisma Client가 생성되지 않은 상태의 빌드 실패는 준비 문제로 분리하고, 격리 DB 실행 과정에서 generate 후 빌드한다. 기존 보안 프론트 테스트는 제거된 `api.signOut`·이전 저장 키·이전 프로필 상태를 참조했다. 현재 앱의 실제 로그아웃 콜백, 현재 토큰 키, `state.me.profile`에 대한 escaping을 검증하도록 갱신했다. 서버 실패 시 토큰을 유지해야 한다는 기대 조건은 유지하며 렌더러가 실제로 주입한 표식을 출력했는지도 검사한다. VM DOM 모형을 보완해 미처리 Promise 오류가 없어야 통과한다.

새 SDK 로딩·파일시스템 준비 시간 때문에 120초에 결과 파일을 만들지 못한 기존 실행 도구의 상한은 300초로 늘렸다. HTTP 동작·보안 기대 결과는 완화하지 않았다.

## 백엔드 전체 실패 3건 / 담당: 백엔드·테스트 환경

- `GET /dev/test-accounts` 스위치 활성 시 시드 반환: 약 39.4초 후 `STACK_TRACE_ERROR`. 선언한 30초 상한과 관련됐을 가능성이 있으나, 응답 assertion 불일치는 확인하지 못했다. 빠른 CI/격리 환경에서 재실행하고 SDK 모듈 재로딩 시간을 분리해야 한다.
- 업로드 용량 초과 413: 약 8초 후 `TypeError: fetch failed`. 기존 테스트는 6000×6000 비압축 PNG(약 108MB)를 FormData로 보낸다. 초과 파일 수용을 입증한 실패가 아니라 HTTP 거부 응답을 받지 못한 전송 실패다. 10MiB 직상회 입력과 실제 브라우저/LB body limit을 별도로 확인한다.
- 프록시 미설정 시 헤더 무시: 약 30.1초 후 `STACK_TRACE_ERROR`. 30초 상한 관련 가능성을 구분한다. 별도 실제 관리자 API의 X-Forwarded-For 위조 403 시험은 통과했으나 전체 테스트 실패를 대신 없애지 않는다.

증빙 `backend-failures-20261027.json`은 이름·시간·오류 종류만 포함한다. 원문 로그·JWT·사진 URL·비밀번호는 Git에 넣지 않는다.

## IMG-01 [P2] 동시 업로드 충돌 500 및 객체 잔여 / 담당: 백엔드

재현: 기존 사진 1장인 시드 사용자(user1)의 slot 2를 정상 업로드한 뒤 같은 slot 3으로 두 POST `/api/v1/me/images` 요청을 Promise.all로 보낸다. fixture는 가상 JPEG이며 `live-image-state-audit.mjs`가 처음부터 재현한다.

기대: 한 요청 202, 다른 요청 409, 원본 DB 행은 최대 3개이며 실패한 요청의 저장 객체는 남지 않는다.

실제: **[202, 500]**, DB 원본 3개·slot 3 원본 1개. DB 유일성은 지켜지지만, 원본 버킷과 공개 버킷에 **각각 DB가 참조하지 않는 객체 1개**가 남았다. SDK로 해당 사용자 경로의 객체 목록을 읽고 DB object key 집합과 비교했으며 증빙에는 건수만 기록했다. 원본이 공개됐다는 증거는 아니며, 보관·삭제 정합성과 비용 관리 문제다.

원인 경로: `backend/src/routes/images.ts`는 slot 조회 후 두 객체를 업로드하고 DB 트랜잭션을 시작한다. `ProfileImage`의 `(userId,slot,imageType)` 유일성 충돌은 일반 500으로 처리되고 이미 저장한 두 객체를 정리하지 않는다. 슬롯 원자적 예약/동시성 제어, 충돌 409 매핑, DB 저장 실패 시 객체 정리 또는 재시도 큐를 함께 보완해야 한다. 500만 409로 바꾸면 객체 잔여는 해결되지 않는다. 다른 역할 코드는 수정하지 않고 재현·담당을 남겼다.

## 운영 문서 불일치 / 담당: 인프라

`infra/ncp/init-script.sh`와 `docs/07_NCP_배포_절차.md`는 ADMIN_ALLOWED_IP_CIDRS가 비면 IP 제한을 적용하지 않는다고 설명한다. 실제 `backend/src/lib/admin.ts:isAllowedAddress`는 운영에서 빈 값이면 관리자 요청을 전부 거부한다. 운영 배포 전 허용 대역을 필수 값으로 명시하고 설명을 수정해야 한다. 현재 코드는 안전하게 차단하지만, 헬스체크 성공만으로 관리자 기능 정상 동작을 보장하지 못한다.

init script의 TRUST_PROXY 기본 1은 직접 앱 포트에 도달하는 클라이언트를 막는 네트워크 조건과 함께 적용해야 한다. 배포 문서는 App ACG에 LB ACG→8080만 허용하도록 적고 있다. 이번에는 실제 NCP ACG·LB 헤더 정규화·직접 연결 차단을 확인하지 않았으며 문서 존재를 배포 완료로 판정하지 않는다.

## 남은 실환경 검증

채팅 상대 원본 발급은 여전히 빈 배열이므로 수락 후 정상 URL 발급 성공 경로를 검증할 수 없다. 실제 비공개 버킷의 익명 목록/읽기 거부, 변조/만료 서명 URL 거부, 차단·정지·탈퇴 후 재발급 중단은 NCP 환경에서 재검증해야 한다. 전체 권한·상태 조합 및 사진·NAS 복원, 삭제 이력 대조·운영 RPO/RTO는 별도다. 모형에서 통과한 항목만으로 Phase 2 완료·운영 배포 승인을 내리지 않는다.
