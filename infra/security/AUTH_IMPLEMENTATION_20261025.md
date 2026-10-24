# 승인된 인증 파일 3개 수정 결과 (2026-10-25)

PR #12의 D-03/04와 사용자의 '인증 파일 3개 수정 진행' 승인에 따라 config.ts·middleware/auth.ts·routes/auth.ts만 수정했다. API 명세와 보안 테스트·증빙도 함께 갱신했다. DB·마이그레이션·프론트·Compose·다른 백엔드 파일은 변경하지 않았다.
기존 PR #13을 최종 구현 범위로 갱신하며 백엔드 담당 리뷰가 필요하다. main/develop에 직접 커밋하지 않는다.

## 구현 결과

| 항목 | 결과 |
|---|---|
| SEC-09 | 모든 환경에서 JWT_SECRET 누락·빈 값·짧은 값·앞뒤 공백·공개 기본 예시 키를 시작 전에 거부. 최소 32 UTF-8 바이트 |
| SEC-07 / D-03 | JWT_EXPIRES_IN, 개발 기본 12h·운영 기본 900s. 단위 없는 문자열·0·음수·잘못된 단위·줄바꿈·안전 정수 초과 거부 |
| SEC-07 | HS256, issuer/audience 연결, sub/iat/exp/iss/aud/jti 발급 및 검증 |
| SEC-01 | 매 요청 DB 사용자 존재·상태·성인 인증 확인. 삭제 계정 401, 정지·탈퇴·미인증 403 |
| SEC-02 | JWT role 대신 현재 DB role 사용. 강등·승격·정지 관리자 회귀 통과 |
| SEC-05 | 로그인에서도 정지·탈퇴·미인증 계정 거부 |

추천 제외·채팅 제한은 전체 로그인을 막지 않고 기능 API에서 별도 적용해야 한다. DB 조회 실패는 인증 성공으로 대체하지 않고 기존 오류 처리기로 전달한다.

## 검증

- TypeScript 빌드 통과. **60개 = 45 통과 / 8 실패 / 7 보류.** 전체 보안 통과는 아니다.
- 운영 모드의 실제 로그인 JWT에서 exp-iat=900초 확인 및 해당 토큰의 /me 인증 통과.
- 개발 43200초·설정 재정의·필수 클레임·알고리즘·계정 상태·현재 역할·키/TTL 경계값 검사 통과.
- Prisma만 mock이며 실제 MySQL·스토리지 통합 검증은 미실행이다. migrate/seed/reset은 실행하지 않았다.
- Node 24.22.1 / Prisma 6.19.3 / Vitest 3.2.7.
- 최신 증빙 `evidence/phase2-results.json`: 기준 HEAD와 실제 테스트한 소스·테스트 SHA-256을 기록한다.
- 수정 전 38개 증빙은 `evidence/phase2-20261025-before-auth-results.json`에 보존했다.

## 배포 영향

1. 기존 JWT에 필수 클레임이 없으면 401이므로 다시 로그인해야 한다. 미병합 개발용 발급 경로도 동일 규칙으로 맞춰야 한다.
2. 실행 전에 개인/배포 JWT_SECRET을 설정한다. Compose의 공개 개발 기본 키도 이제 거부되므로 인프라가 템플릿·비밀 주입을 맞춰야 한다.
3. 암호학적 난수 32바이트 이상을 생성해 Base64 문자열로 보관하는 것을 권장한다. 현재 서버는 문자열 자체를 HMAC 키로 쓰며 Base64 디코딩하지 않는다. 실제 키는 Git·로그에 넣지 않는다.
4. 만료 기준은 JWT_EXPIRES_IN(12h/900s/15m 등)이다. AUTH_ACCESS_TOKEN_TTL_SECONDS는 읽지 않는다. 운영 컨테이너에 NODE_ENV=production을 설정한다.
5. jti 발급만으로 로그아웃 토큰이 폐기되지 않는다. 서버 폐기 저장소는 별도 작업이다.
6. 미인증 계정 로그인/인증은 막지만 register의 adultVerified 임시 처리는 여전히 제공자 검증이 필요하다.
7. 요청별 DB 조회가 추가됐다. 트래픽 성능·실제 DB 장애 동작은 배포 환경에서 재검증한다.

## 남은 실패 8개 및 보류

| 담당 | 항목 |
|---|---|
| 백엔드·DB | 로그아웃 무효화 1개: 세션/jti 저장 방식·스키마 협의 |
| 백엔드 | 가입 성인 인증 제공자 검증 1개 |
| 백엔드·인프라 | 로그인/API 속도 제한 2개 |
| 백엔드·보안 | app.ts 오류 로그 마스킹 1개 (허용 파일 밖) |
| 프론트·인프라 | HTML 출력 1개, 서버 소스·dotfile 제공 2개 |

실제 관리자 API·사진 수락 관계·차단 메시지·감사 로그·업로드·추천 관계·실복구 7개는 보류다. 미구현 404/501을 통과로 처리하지 않는다.

## 재현

의존성이 설치된 루트에서 `node infra/security/run-phase2.mjs`. 남은 실패로 종료 코드 1을 반환한다.
운영 발급 확인만 실행하려면 `node backend/node_modules/vitest/vitest.mjs run --config infra/security/vitest.config.mjs infra/security/tests/production-auth.test.ts`를 사용한다.
