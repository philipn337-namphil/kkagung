# 승인된 보안 수정 결과 (2026-10-25)

사용자가 로그 마스킹·프론트 HTML/파일 노출·채팅 수락 차단 검사의 최소 수정을 추가 승인했다.

## 변경 및 검증

- backend/src/app.ts: 예외 원문·stack·요청 내용을 출력하지 않는다. 서버 생성 event/incidentId만 기록하고 X-Incident-Id로 장애를 연결한다. Zod 오류 응답도 입력 내용을 포함하지 않는 고정 문구를 사용한다. 진단 시 원문 대신 사건 ID와 별도 재현 절차를 사용해야 한다.
- frontend/app.js: 프로필 입력 속성·소개 textarea·홈 이름·추천 카드의 동적 값을 HTML 인코딩한다. 태그·따옴표·textarea 탈출 입력을 회귀 검사했다.
- frontend/server.js: /, /index.html, /app.js, /styles.css, /config.js만 제공한다. .env, 서버 소스, 패키지·Docker 파일, 인코딩 경로는 404로 거부한다. 새 공개 자산 추가 시 allowlist도 수정해야 한다.
- 빌드 PASS. 회귀 테스트 **71개 = 60 통과 / 4 실패 / 7 보류**. 기존 60개와 비교하여 기존 실패 4개 해소 및 11개 회귀 사례 추가. 종료 코드 1은 아래 남은 4개 실패 때문이다.

## 채팅 수락 수정

별도 feature/security-chat-block 브랜치의 c1ce830은 소셜 브랜치 e24bcd3을 기반으로 chatRequests.ts와 API 명세만 수정했다. 기존 요청 수락 전에 양방향 차단을 검사한다. 실제 수정 커밋의 라우트로 **24/24 통과**했다. 과거 원본 결과(23/24)와 수정 결과는 별도 증빙으로 보존한다.

이 브랜치는 아직 미병합된 소셜 코드에 의존한다. develop 통합 전 전체 빌드·실 DB·새 JWT 미들웨어 결합 시험이 필요하다. 이 수정은 이미 존재하는 차단 관계 검사 결함을 해결하며, 차단/수락 동시 실행의 DB 잠금 정합성을 보장하지는 않는다. 백엔드 담당이 별도 검토해야 한다.

```powershell
node infra/security/run-phase2.mjs
$env:SOCIAL_AUDIT_REVISION='c1ce830db2110a9d66153c138cf0d480d4542278'
$env:SOCIAL_AUDIT_FIXED='1'
node --test --test-reporter=tap infra/security/social-route-audit.test.mjs
```

증빙: evidence/phase2-results.json, evidence/social-fixed-route-audit.tap, evidence/social-fixed-source-provenance.json. 실제 HTTP 라우트와 mock Prisma·인증 주체를 이용했다. 실제 DB·스토리지 통합 결과가 아니다. 두 테스트 묶음은 합산하지 않는다.

## 남은 작업과 담당

- 백엔드·DB: 로그아웃 후 토큰 폐기 — 로그인→로그아웃→같은 토큰으로 /me 호출 시 여전히 200.
- 백엔드·인증 연동: 클라이언트 adultVerified=true만으로 가입 성공. 실제 제공자 검증 필요.
- 백엔드·인프라: 로그인 실패 반복(50회)·일반 API 반복(100회)에 429 미반환. 분산 저장소·프록시 신뢰 범위 합의 필요.
- 백엔드·스토리지: 실제 사진 업로드 형식/크기/픽셀/메타데이터, 수락 후 원본 접근, 관리자 API·감사 로그 통합 검증.
- 인프라·운영: 실제 백업 복원·복구 시간 증빙. 테스트 DB·스토리지 준비 전 미실행.

이번 결과로 Phase 2 전체 완료 또는 운영 배포 가능으로 판정하지 않는다.
