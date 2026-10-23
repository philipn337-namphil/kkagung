# 보안·운영 검증 실행

- 범위·담당자별 문제·재현: [PHASE2_FINDINGS.md](PHASE2_FINDINGS.md)
- 전체 체크리스트: [security-test-checklist.md](security-test-checklist.md)
- 복구 절차: [BACKUP_RESTORE_CHECKLIST.md](BACKUP_RESTORE_CHECKLIST.md)
- 비밀 없는 결과: [evidence/phase2-results.json](evidence/phase2-results.json)

## 재실행

Node 24와 npm, 백엔드 잠금 파일의 의존성이 필요하다. 실제 DB·스토리지·외부 API는 사용하지 않는다.

```powershell
Push-Location backend
npm ci --ignore-scripts
npx prisma generate
Pop-Location
node infra/security/run-phase2.mjs
```

실제 DB에 마이그레이션하거나 시드를 넣는 명령은 실행하지 않는다. Prisma 엔진 생성은 빌드용이다.
테스트는 루프백 HTTP 연결을 사용한다. 샌드박스가 연결을 막으면 승인된 환경에서 같은 명령을 실행한다.
스크립트는 TypeScript 빌드 후 Vitest를 실행하고 증빙을 갱신한다. 테스트 이름·판정만 저장하고 토큰·비밀번호·원본 URL은 저장하지 않는다.
실패를 expected-failure로 숨기지 않는다. 현재 종료 코드 1은 발견된 12개 미충족 때문이다.
7개 skip은 관리자·사진·채팅·업로드·복구 기능이 준비됐을 때 실제 통합 테스트로 교체해야 하는 추적 항목이다.

## 협업 범위

backend/frontend/Compose/API/DB 계약은 변경하지 않았다. 수정은 발견 보고서의 담당자와 합의 후 해당 역할 브랜치에서 진행한다.
이 검증 PR은 Phase 2 보안 통과·배포 승인이 아니다. 백엔드의 검증 기준 기능이 추가되면 대상 커밋을 갱신하고 다시 실행한다.
