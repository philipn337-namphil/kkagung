# Phase 2 병합 후 재검증 및 PR #19·#20 검토

## 대상과 결과

PR #13·#17·#18 및 백엔드 기능이 병합된 develop 1b02f98186fc7caa9f4ebf91f0b7a1b70b228c26을 기준으로 새 feature/security-phase2-integration에서 검증했다. 다른 담당자의 브랜치나 main/develop에는 직접 커밋하지 않았다.

| 묶음 | 대상 | 결과 |
|---|---|---|
| 주요 회귀·빌드 | 병합 develop | 빌드 PASS, 79개 중 73 통과·0 실패·6 대기 |
| 전체 앱 JWT·관리자 통합 | develop 1b02f98 | 11개 중 10 통과·1 실패 |
| 동일 전체 앱 시험 | PR #19 e50e9ac9c563bcf9a15bdbd954399fca1c8e18bf | 11/11 통과, 별도 TypeScript 빌드 PASS |
| 새 프론트 | PR #20 ef1f722636d69f9cdd02bb67fb7ead1403b2fd89 | 12개 중 6 통과·6 실패 |
| 최소 프론트 보안 수정 | 8a5d0bf8839d5e2be52fabf4fafd656d93105b75 | 구문 검사 PASS, 12개 중 10 통과·2 실패 |

서로 다른 시험을 합산하지 않는다. 기존 실제 관리자 API 부재 skip 1개는 병합 후 실제 경로에서 현재 USER가 오래된 ADMIN 클레임을 가져도 403인 실행 시험으로 바꿨다. 감사 로그 영속성 등 나머지 6개 통합 대기는 유지했다.

## PR #19 — 개발 토큰과 보호 API 연결 확인

담당: 백엔드 인증. develop의 POST /dev/test-accounts/1/token은 200으로 토큰을 주지만 해당 토큰으로 GET /me 호출 시 401이다. PR #19에서는 200으로 통과한다. 일반 로그인→/me, 실제 관리자 API의 USER·권한 회수·정지·만료·위조 거부, 관리자 설정 전후 감사 호출, 로그아웃 재사용 401, 운영 개발 경로 404·가입 403도 함께 통과했다.

snapshot-app.mjs는 Git 객체의 **앱 전체·JWT 발급·인증·관리자 미들웨어를 변경 없이** 로드하고 Prisma 경계만 대체한다. 기존 역할 주입 테스트보다 실제 인증 경로를 넓게 확인했으나 MySQL·지속성·동시성 시험은 아니다. 대상 커밋의 모든 로드 소스 해시는 merged-app-*-provenance.json에 기록한다.

PR #19를 분리된 로컬 작업 폴더에서 TypeScript 빌드했다. 스키마가 develop과 동일함을 확인해 기존 생성 Client를 읽기 재사용했으며 실제 DB를 변경하지 않았다. PR 작성자의 '실 MySQL 113개 통과'는 이번 환경에서 독립 재실행한 결과가 아니다.

### 테스트 운영 주의 / 담당: 백엔드·인프라

PR #19의 tests/setup.ts는 beforeAll/afterAll마다 rateLimitCounter.deleteMany({})로 카운터를 전부 삭제한다. DATABASE_URL이 공유/운영 DB를 가리키면 실제 제한 상태를 지울 수 있다. 설정 파일에 테스트 DB 이름·환경 허용 검사 또는 전용 DB 격리 장치를 추가해야 한다. 이번에는 이 DB 테스트 스위트를 실행하지 않았다.

제재 동시성 실패도 남아 있다. 서로 다른 두 제재 요청이 각각 상태를 읽는 시점에 따라 연속 두 번 성공할 수 있다. 현재 서버가 읽은 status를 update 조건에 쓰는 방식만으로는 클라이언트가 관측한 버전 충돌을 보장하지 못한다. 담당자가 기대 계약(연속 변경 허용 여부)과 version/expected-status 조건을 함께 정해야 한다. 실제 DB에서 재현했다고 주장하지 않는다.

## PR #20 — 보안 회귀와 기능 계약

담당: 프론트. 원본 app.js를 VM에서 실행해 DOM 문자열·fetch 본문·로그아웃 콜백을 확인했다. 실제 브라우저 스크립트 실행·실서버 통신이 아니다.

| ID | 재현·실제 결과 | 처리 |
|---|---|---|
| FE20-01 | logout 500 시 finally가 sessionStorage 토큰을 지움. 네트워크 오류도 api.logout이 성공처럼 반환하여 서버 폐기 재시도 불가 | 별도 보안 수정 8a5d0bf: 성공 또는 이미 무효한 401일 때만 삭제, 네트워크/서버 오류 전파 |
| FE20-02 | publicImage.type=ORIGINAL_PRIVATE인 합성 입력의 URL도 공개 카드 img src로 출력 | 같은 수정에서 AI_PUBLIC/BLURRED_PUBLIC과 HTTP(S)만 허용 |
| FE20-03 | card.color에 속성 탈출 합성 문자열을 넣으면 원문 HTML 출력 | 같은 수정에서 색상 허용 목록 적용 |
| FE20-04 | api.sendMessage가 {content:...}를 전송하나 백엔드 스키마는 {body:...}. 응답도 senderId/body인데 프론트는 senderUserId/content를 읽음 | 미수정, 프론트 담당이 요청·응답 매핑 수정 후 실제 채팅 시험 |
| FE20-05 | api.imageStatus는 /me/images를 호출하나 구현된 경로는 /me/images/status. 전자는 404이고 fallback도 없음 | 미수정, 프론트 담당이 경로 수정. 올바른 경로도 현재 501이므로 업로드 구현 완료와 별개 |

FE20-02/03은 계약을 벗어난 입력에 대한 추가 방어다. 현재 백엔드 공개 카드가 실제 원본 URL을 반환한다거나 저장형 XSS가 발생했다고 입증한 것이 아니다. 기존 displayName/intro 인코딩과 401/403/404/409/429를 mock 성공으로 바꾸지 않는 처리는 통과했다.

보안 수정은 PR #20 기반 별도 feature/security-frontend-regressions에 frontend/app.js 3개 줄만 변경했다. 프론트 담당 원본 브랜치는 직접 바꾸지 않았다. 기능 계약 두 문제는 보안 최소 수정 범위를 넓히지 않고 재현·담당을 남겼다. 남은 실패 2개를 skip이나 expected-failure로 숨기지 않았다.

보안 보완은 develop 대상 초안 PR #21로 제출했다. PR #20에 의존하므로 선행 통합 또는 프론트 담당의 수정 반영 후 같은 테스트를 재실행해야 한다.

## 실행

```powershell
node infra/security/run-phase2.mjs
node --test --test-reporter=tap infra/security/merged-app-audit.test.mjs
$env:MERGED_APP_REVISION='e50e9ac9c563bcf9a15bdbd954399fca1c8e18bf'
$env:MERGED_APP_FIXED='1'
node --test --test-reporter=tap infra/security/merged-app-audit.test.mjs
node --test --test-reporter=tap infra/security/frontend-pr20-audit.test.mjs
$env:FRONTEND_AUDIT_REVISION='8a5d0bf8839d5e2be52fabf4fafd656d93105b75'
$env:FRONTEND_AUDIT_FIXED='1'
node --test --test-reporter=tap infra/security/frontend-pr20-audit.test.mjs
```

환경 변수 없는 실행은 고정된 원본 develop/PR #20의 문제를 재현하므로 종료 1이다. 증빙은 evidence/merged-app-*.tap, frontend-pr20-audit.tap, frontend-security-fixed.tap 및 각각의 provenance.json이다. 원문 토큰·비밀번호·실제 사진을 출력하지 않는다.

## 실제 환경 한계

현재 로컬에는 .env 파일이나 Docker/MySQL 명령이 확인되지 않았고 localhost:3306도 연결되지 않았다. 실제 DB 스위트·마이그레이션·복구는 실행하지 않았다. 업로드 MIME/용량/픽셀/메타데이터와 수락 전후 원본 접근·운영 프록시·성인 인증 제공자는 계속 대기다. 이번 시험으로 전체 Phase 2 완료 또는 출시 승인 판정을 하지 않는다.
