# 보안·운영 검증 실행

## 현재 판정

병합 후 최신 결과는 [INTEGRATION_REVIEW_20261025.md](INTEGRATION_REVIEW_20261025.md)를 우선한다. develop 1b02f98의 주요 회귀는 **79개 중 73 통과·0 실패·6 대기**다. 실제 관리자 API 403 항목이 실행 가능해졌다. 별도 전체 앱 시험은 develop 10/11, PR #19 11/11 통과. PR #20은 6/12, 최소 보안 수정 후 10/12 통과이며 기능 계약 2개는 프론트 담당 수정이 필요하다. 아래 표는 병합 전 이력이다.

| 검증 묶음 | 결과 | 범위·한계 |
|---|---|---|
| 주요 보안 회귀 | 빌드 통과, 79개 중 73 통과·0 실패·6 통합 대기 | 병합 develop의 실제 HTTP/JWT/bcrypt, mock DB |
| 채팅 수정 c1ce830 / PR #17 | 24/24 통과 | 소셜 라우트, mock 인증·DB |
| 관리자 수정 826f293 / PR #18 | 전체 빌드 통과, 19/19 통과 | 관리자 라우트·CIDR·감사 호출, mock 인증·DB |

서로 다른 묶음은 합산하지 않는다. PR #13·#17·#18은 develop에 통합됐다. 실제 DB·사진·복구 검증은 미완료다. PR #19 토큰 발급 통합과 PR #20 프론트·보안 보완 PR #21은 별도 검토 대상이다. 전체 Phase 2 완료 또는 출시 승인이 아니다.

- [최신 후속 구현](SECURITY_FOLLOWUP_20261025.md): 토큰 폐기·공용 속도 제한·운영 가입 차단.
- [관리자 수정 결과](ADMIN_FIXES_20261025.md): CIDR 오류 거부·감사 전후 값.
- [체크리스트](security-test-checklist.md), [보안 저장소 운영](SECURITY_STORAGE_20261025.md), [실제 복구 점검](BACKUP_RESTORE_CHECKLIST.md).
- 병합 후 검증·PR #19/#20 재현은 INTEGRATION_REVIEW_20261025.md, 프론트 최소 보안 보완은 PR #21을 따른다.

## 다른 담당자 없이 실행 가능한 로컬 점검

Node만 있으면 실행할 수 있다. 아래 시험은 운영 DB·스토리지·실제 사진·비밀값에 접근하지 않는다.

```powershell
node --test --test-reporter=tap infra/security/tests/local-ops.test.mjs
node infra/security/check-git-safety.mjs --evidence
node infra/security/local-backup-drill.mjs --evidence
```

Git 검사기는 **현재 index에 들어간 파일**을 읽는다. 새 파일·수정 내용을 검사하려면 필요한 파일만 먼저 `git add`한 뒤 실행한다. 무시된 로컬 .env나 Git 과거 이력은 읽지 않는다. 금지 경로·키 파일·덤프, 개인키 본문·일부 키/JWT 리터럴, 예제 환경 파일의 비어 있지 않은 서명/API 키를 찾는다. 결과에는 경로·규칙만 기록한다. 모든 형태의 비밀값을 탐지하는 도구는 아니므로 수동 diff 확인도 필요하다. 발견 시 종료 1, 검사 실행 오류는 2다. 배포 승인을 뜻하지 않는다.

백업 연습은 새 임시 폴더의 가상 데이터만 AES-256-GCM으로 암호화·복원하고 해시·레코드 일치, 변조·잘림·잘못된 인증 태그 거부를 확인한다. 키는 메모리에만 두며 종료 시 임시 파일을 정리한다. 측정 시간은 로컬 fixture 실행 시간으로 실제 RTO가 아니다. DB·버킷 접근 제어 또는 실제 백업 복구 완료로 표시하지 않는다.

증빙은 evidence/git-safety-results.json, local-backup-drill.json, local-ops-tests.tap에 기록한다.

## 주요 회귀 재실행

Node 24, backend 잠금 파일의 의존성과 생성된 Prisma Client가 필요하다.

```powershell
Push-Location backend
npm ci --ignore-scripts
npx prisma generate
Pop-Location
node infra/security/run-phase2.mjs
```

실제 DB에 migrate/seed/reset하지 않는다. 스크립트는 빌드와 루프백 HTTP 테스트를 실행하고 비밀값을 제외한 결과·소스 해시를 evidence/phase2-results.json에 기록한다. 6개 skip은 실제 DB·스토리지·복구 통합 대기로 유지한다.

## 채팅·관리자 수정 커밋 별도 재실행

해당 커밋이 로컬 Git에 있어야 한다. 대상 코드를 checkout/merge하지 않고 Git 객체에서 읽는다.

```powershell
$env:SOCIAL_AUDIT_REVISION='c1ce830db2110a9d66153c138cf0d480d4542278'
$env:SOCIAL_AUDIT_FIXED='1'
node --test --test-reporter=tap infra/security/social-route-audit.test.mjs
$env:ADMIN_AUDIT_REVISION='826f293ce054d4b7cd1c6062d0cbc8238a00b0a0'
$env:ADMIN_AUDIT_FIXED='1'
node --test --test-reporter=tap infra/security/admin-route-audit.test.mjs
```

환경 변수 없이 실행하면 수정 전 원본 결함을 재현한다. 실패를 expected-failure로 숨기지 않는다. 수정 전 결과는 별도 증빙으로 보존한다.

## 이력

AUTH_IMPLEMENTATION_20261025.md, REVALIDATION_20261025.md, SECURITY_FIXES_20261025.md, ADMIN_REVIEW_20261025.md, SOCIAL_REVIEW_20261025.md에는 이전 수치·발견 이력이 있다. 현재 판정은 위 표와 최신 수정 결과를 우선한다.
