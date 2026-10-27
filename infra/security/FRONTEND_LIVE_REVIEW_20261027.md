# 실제 프론트·API 통합 검증

대상: 보안 브랜치 `7500420` 기준. 최신 origin/develop은 `70fc9e3`, origin/feature/frontend는 `ef1f722`다. 프론트 기능 커밋 `d2d976a`가 현재 HEAD의 조상임을 확인했다. frontend 브랜치 대비 app.js 차이는 기존 로그아웃·메시지 필드·이미지 상태 경로·출력 인코딩 보안 보완이며, 이를 되돌리는 병합은 하지 않았다.

## 판정과 범위

전체 백엔드 **145 통과·0 실패·0 대기**, 빌드 PASS. 실제 MySQL·Sharp·Moto를 사용하고 worker 1, 개별 시험 60초로 실행했다. 이전 전체 141/144와 선택 31/31 결과를 대체하는 최신 전체 실행이며 서로 합산하지 않는다.

최종 프론트 통합은 **28개 중 23 통과·5 실패**다. 실제 API 호출 138회 중 목업 전환 조건인 네트워크 오류/501은 0회였고, 새로고침은 새 카드 1개·USED 후 재사용 409를 확인했다. 실패 5개는 아래 FE-01~05이며 모두 프론트 담당이다. 전체 실행은 failed-tests/종료 1을 유지한다. 로컬 DB 20개 테이블 복원 건수·SHA-256은 일치했고 임시 MySQL·Moto·HTTP 서버와 검증용 브라우저 탭을 정리했다.

프론트는 수정하지 않고 기존 API client와 렌더러를 VM의 최소 DOM에서 실제 HTTP API에 연결했다. 별도로 실제 브라우저의 두 계정으로 로그인→운세/추천→하트→요청→수락→메시지 송수신→차단→신규 메시지 거부를 확인했다. VM 결과를 브라우저 전수 검증으로 부르지 않는다. 모바일 390px·모든 입력 폼의 브라우저 XSS 실행 여부는 이번 검증 범위가 아니다.

검증용 FRONTEND_URL=*는 무작위 루프백 포트의 격리 프로세스에만 사용했다. 최초 브라우저 준비 과정에서 CORS_ORIGIN이라는 잘못된 설정명을 사용한 것을 바로잡았다. 제품 설정이나 배포 파일은 변경하지 않았다.

## 프론트 담당 수정 항목

| ID | 우선순위·담당 | 재현 | 실제 결과 / 수정 기준 |
|---|---|---|---|
| FE-01 | P2·프론트 | 상대에게 가상 사진 업로드 → 채팅 수락 → 방 상세 조회 | API의 partner.originalImages에는 60초 URL이 있고 실제 파일도 200이지만 loadRoom은 사진을 렌더링하지 않음. 허용된 방에서만 표시하고 만료·차단·계정 전환 시 정리 필요 |
| FE-02 | P2·프론트 | DONE/publicUrl 응답이 있는 계정 → 마이페이지 | DONE인데 '공개 이미지 준비 중'. loadImageStatus가 응답의 publicUrl 대신 publicImage.url을 읽음. 실제 계약에 맞게 표시 필요 |
| FE-03 | P2·프론트 | 요청자를 CHAT_RESTRICTED로 변경 → 방 재조회 | canSendMessage=false인데 입력/전송 폼이 활성 상태. loadRoom에서 서버의 전송 가능 여부를 반영해야 함. 서버는 메시지 거부·DB 미기록으로 정상 보호 |
| FE-04 | P2·프론트 | 추천 열람·하트 후 정상 로그아웃 → 다른 계정 로그인 | 토큰은 삭제/서버 폐기되지만 cards/daily/mock 상호작용과 notices가 남음. 기존 추천 3개 잔존과 이전 계정 차단 알림의 다른 계정 노출 재현. 로그아웃 성공·401·계정 전환에서 사용자별 상태 정리 필요 |
| FE-05 | P2·프론트 | 정상 API 성공 후 다음 요청에 501 응답을 주입 | 목업 반환 후에도 footer가 'API 연결'. request의 source='api'가 fallback에서 정리되지 않음. 반환 데이터의 출처와 명시적 목업 표시를 일치시키고 운영 목업 비활성 설정 검토 필요 |

FE-01/02/04는 실제 브라우저 표시도 확인했다. FE-03은 실제 DB 상태 변경·HTTP 응답과 VM 폼 상태로, FE-05는 별도 오류 응답 주입으로 재현했다. FE-04는 다른 사용자 토큰 재사용이나 서버 인증 우회가 확인됐다는 뜻은 아니다. FE-05도 401/403 등을 목업으로 숨기는 문제와 구분한다.

수정 대상은 frontend/app.js의 loadRoom, loadImageStatus, bind의 로그아웃 처리, loadMe/completeLogin과 fallback 출처 처리다. 다른 역할 코드를 수정하기 전 합의하라는 지시에 따라 이번에는 제품 코드를 변경하지 않았다. 프론트 담당이 수정한 뒤 같은 도구의 실패 5개를 재검증해야 한다.

## 통과한 주요 항목

- 실제 개발 테스트 계정 로그인·me·운세·추천 표시, 하트 DB 반영·중복 409.
- 신고 DB 반영, 채팅 요청·수락·거절, 방 참여자 생성, 메시지 왕복과 출력 인코딩.
- 원본은 공개 카드에서 미노출. 수락된 방의 원본 URL과 실제 가상 파일 읽기 성공.
- 일반 사용자 관리자 API 403, 관리자 실제 대시보드 필드 표시.
- 차단 후 신규 메시지 거부·DB 미기록·새 원본 URL 미발급.
- 정상 로그아웃 후 기존 JWT 401. 실제 429를 API client가 오류로 유지.
- 401/403/404/409/429 응답 주입에서도 목업으로 바꾸지 않고 상태를 표시.
- 프론트 공개 파일 허용 목록·비공개 파일 404, 실제 API 주소 주입 확인.

서비스에는 목업을 끄는 전용 설정이 없다. 기능 시험 중 네트워크 오류/501이 발생해 목업 성공으로 대체되지 않았는지 별도 계수하고, 오류 주입 검사는 분리했다. 실제 API에서 받은 데이터와 DB 반영을 대조한 결과이며 목업 데이터로 성공 시나리오를 채우지 않았다.

## 실행·증빙

```powershell
# 새 임시 MySQL·Moto에서 전체 백엔드와 프론트 통합 시험
node infra/security/run-storage-gates.mjs <mysqlHome> <python> <motoPackages> --frontend
# 프론트 수정/시험 조건 보완 후 통합 부분만 재실행
node infra/security/run-storage-gates.mjs <mysqlHome> <python> <motoPackages> --frontend-only
```

실패 항목이 있으면 종료 1, failed-tests로 남긴다. 기대값을 제품 동작에 맞춰 완화하거나 skip 처리하지 않았다. 시험 대상은 실행기가 만든 새 DB 이름·사용자·루프백 주소·실행 ID로 제한한다. 실제 비밀값·JWT·원본/서명 URL·채팅 원문·덤프는 증빙에 기록하지 않는다.

- 전체 백엔드/복원: `evidence/portable-db-frontend.json` (backend-tests=true, 145/145; frontend-audit=false)
- 최신 프론트: `evidence/live-frontend-audit.json`, `portable-db-frontend-only.json`, `storage-frontend-only.json`
- 최초 18/22 결과: `live-frontend-initial.json`
- 브라우저 수동 관찰: `evidence/frontend-browser-review.json`
- 실제 NCP ACL·만료 검증과 운영 DB/사진/NAS·RPO/RTO는 별도 미완료

추가 시험의 첫 실행에서 새로고침권 재사용 거부 기대가 실패했다. 가상 사용자에게 이미 모든 후보가 노출돼 빈 목록을 반환하고 권을 소모하지 않는 정상 계약이었다. 새 가상 후보를 준비하는 시험 조건을 추가했고 최초 결과는 `live-frontend-refresh-fixture-failure.json`에 보존했다. 이 실패를 제품 결함으로 집계하지 않는다.

프론트 README의 '백엔드 구현 대기 API' 목록도 현재와 다르다. 하트·채팅·차단·신고·이미지·관리자 API가 실제 응답하므로 프론트 담당이 문서와 남은 UI 항목을 함께 갱신해야 한다.
