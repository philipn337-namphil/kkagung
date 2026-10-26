# 2026-10-25 Phase 2 보안 재검증

## 범위와 결론

- 대상: develop `aae89c787e8dc4ae428e315f4c5ee507fc84f300`.
- 기존 검증 PR #9는 2026-10-24 병합됐다. 이번 작업은 이후 코드·결정사항을 기준으로 한 재검증이며 별도 PR로 제출한다.
- 사용자는 다른 역할 코드에 대해 **검증·보고서만 진행**하도록 지정했다. D-04의 인증 파일 수정 허용에도 불구하고 이번 작업에서는 backend/frontend/API/DB 코드를 변경하지 않았다.
- 실제 Express HTTP·JWT·bcrypt·프론트 핸들러를 사용하고 Prisma만 mock한다. 실제 MySQL·스토리지·NAS 복구 결과가 아니다.
- **TypeScript 빌드 통과. 38개 테스트 = 10 통과 / 21 실패 / 7 보류.** 보안 출시 기준은 아직 미충족이다.

## 이전과 달라진 점

| 항목 | 확인 결과 |
|---|---|
| 사진 스키마·시드 | ProfileImage 모델·마이그레이션·9개 가상 계정 및 가짜 이미지 참조가 추가됨. Prisma Client 재생성 후 빌드 통과 |
| 실제 사진·저장소 | 시드는 객체 키만 생성한다. 파일·버킷의 존재나 비공개 권한을 입증하지 않음 |
| JWT TTL 결정 | D-03: 개발 기본 12h / 운영 기본 900s / JWT_EXPIRES_IN. 더 이상 미결정 충돌로 분류하지 않음 |
| 실제 인증 코드 | 로그인 TTL은 여전히 12h 하드코딩. config.jwtExpiresIn와 환경 변수 재정의는 미구현 |
| 보안 수정 권한 | D-04에는 3개 인증 파일 허용이 있지만 사용자의 검증 전용 범위를 유지함 |
| 추천 코드 | origin/feature/backend-dev-accounts에 daily/recommendations 등 존재. develop에는 미병합이므로 통합 검증하지 않음 |

## 테스트 결과와 담당

| 시나리오 | 판정 | 관측 / 담당 |
|---|---|---|
| 무토큰·만료·서명 위조·잘못된 sub | 통과 4 | /me에서 401 / 백엔드 |
| 유효 계정 본인 조회·타인 userId 쓰기 우회 방지 | 통과 2 | HTTP 200, 실제 쓰기 주체는 인증 사용자 / 백엔드 |
| 정지 계정 신규 로그인 | 통과 1 | 403. 기존 토큰 접근 제한과는 별개 / 백엔드 |
| 개발 JWT TTL | 통과 1 | D-03에 맞게 43200초 / 백엔드 |
| USER 관리자 미들웨어 | 통과 1 | 403. 실제 관리자 API 통합 판정은 보류 / 백엔드 |
| 정상 프론트 정적 페이지 | 통과 1 | 200 / 프론트 |
| 정지·탈퇴·미인증 계정의 기존 토큰 | 실패 3 | /me 200 / 백엔드 SEC-01 |
| 로그아웃 후 기존 토큰 | 실패 1 | /me 200 / 백엔드 SEC-03, DB 협의 필요 |
| 클라이언트 성인 인증 플래그 신뢰 | 실패 1 | register 201 / 백엔드 SEC-04 |
| 탈퇴 계정 신규 로그인 | 실패 1 | 200 / 백엔드 SEC-05 |
| 발급자/대상·HS256 외 알고리즘·exp 누락 | 실패 3 | 유효 서명의 다른 iss/aud·HS512·exp 없는 토큰도 200 / 백엔드 SEC-07 |
| JWT 필수 클레임 | 실패 1 | 로그인 JWT iss/aud/jti 없음 / 백엔드 SEC-07 |
| 로그인/API burst | 실패 2 | 50/100회에 429 없음 / 백엔드+인프라 SEC-06 |
| 합성 오류 로그 민감값 마스킹 | 실패 1 | 표식 그대로 출력 / 백엔드+보안 SEC-08 |
| 회수된 관리자 역할의 이전 토큰 | 실패 1 | 미들웨어 next 진행 / 백엔드 SEC-02 |
| 프로필 출력 인코딩 | 실패 1 | HTML 표식 미인코딩 / 프론트 SEC-10 |
| 서버 소스·dotfile 정적 제공 | 실패 2 | /server.js, /.env.example 모두 200 / 프론트+인프라 SEC-11 |
| 운영 JWT 빈 키 시작 거부 | 실패 1 | 설정 import 성공 / 백엔드 SEC-09 |
| D-03 환경별 기본값·재정의 | 실패 3 | 개발·운영·재정의 모두 config.jwtExpiresIn 없음 / 백엔드 SEC-07 |
| 실제 관리자·사진·차단·감사·업로드·추천 관계·복구 | 보류 7 | API/실자원/병합 준비 후 통합 검증 |

새로 추가한 8개는 3 통과·5 실패다. 이전 테스트 수와 달라졌으므로 실패 수 증가를 취약점 악화로 단정하지 않는다. 12시간 자체는 결함이 아니며 운영 15분 및 환경 변수 연결 미구현이 문제다.

## 실행과 증빙

```powershell
Push-Location backend
npx prisma generate
Pop-Location
node infra/security/run-phase2.mjs
```

기존 backend/package-lock.json 기준 의존성이 설치된 환경이다. Node 24.22.1 / Prisma 6.19.3 / Vitest 3.2.7.
실제 DB에 migrate/seed/reset을 실행하지 않았다. 토큰·비밀번호는 실행 때 무작위 생성하며 운영·개인 자격 증명은 사용하지 않았다.

- 최신: `evidence/phase2-results.json` (baseline aae89c7).
- 10월 23일 후속: `evidence/phase2-20261023-followup-results.json` (30개 결과 보존).
- 최초: `evidence/phase2-initial-results.json` (25개 결과 보존).

개별 재현은 `node backend/node_modules/vitest/vitest.mjs run --config infra/security/vitest.config.mjs -t "테스트 이름"`으로 선택한다. config 검사는 먼저 빌드가 필요하다. JWT·계정 검사는 phase2.test.ts, 프론트·운영 설정 검사는 frontend-config.test.ts에 있다.

## 다음 담당자 작업

1. 백엔드: D-03 TTL 설정·필수 클레임·알고리즘·현재 DB 역할/상태/성인 인증 검사를 구현하고 SEC-01/02/05/07/09 재검증 요청.
2. 백엔드+DB: SEC-03 세션 무효화 방식을 합의하고 DB 변경 시 migration·ERD 함께 수정.
3. 프론트: SEC-10 텍스트 안전 출력, SEC-11 정적 파일 allowlist/dotfile 차단.
4. 인프라+백엔드: 속도 제한 저장소·신뢰 프록시·개발 기본 키 처리 확정. 이전 한도표는 제안이며 확정값으로 표시하지 않음.
5. 백엔드: 개발 계정 브랜치를 develop에 통합한 후 추천·권한 시나리오 재검증. 실제 관리자 API 담당과 일정은 결정 문서에서 여전히 미정.
6. 인프라: 승인된 테스트 MySQL·스토리지·NAS 환경을 준비하고 BACKUP_RESTORE_CHECKLIST.md에 따라 실복구. 로컬 Docker/MySQL CLI가 확인되지 않아 이번에는 수행하지 않음.

아직 통과하지 않은 시나리오를 완료로 표시하지 않는다. 테스트 전용 mock 또는 시드 사진 행만으로 실제 사진 보호를 승인하지 않는다.
