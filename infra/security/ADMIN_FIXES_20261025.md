# 관리자 보안 수정 결과

사용자의 후속 진행 요청에 따라 별도 feature/security-admin-hardening 브랜치에서 관리자 문제 2개를 수정했다. 기준은 미병합 feature/backend-admin cc021c7이며 수정 커밋은 826f293ce054d4b7cd1c6062d0cbc8238a00b0a0이다. 다른 관리자 기능 전체를 feature/security-ops에 병합하지 않았다.

## 변경

- ADM-01: node:net의 isIP로 주소 형식을 검사한다. 정확한 IPv4/IPv6 주소와 IPv4 CIDR만 지원한다. 빈 prefix, 범위 밖 prefix/옥텟, 여러 slash, 지수 표기, 빈 목록 항목, 잘못된 항목과 정상 항목 혼합은 목록 전체를 거부한다. 전달 주소 헤더는 계속 무시한다. 명시적 IPv4 /0은 유효한 문법이지만 모든 주소 허용이므로 운영 허용 목록으로 사용하지 않아야 한다.
- ADM-02: 배지 설정을 쓰기 전 해당 서비스 날짜의 기존 유효 값을 조회해 beforeValue에 담는다. 기존 값이 없으면 화면과 같은 기본값 10/5/30을 기록한다. 조회·설정 쓰기·감사 기록을 Serializable 트랜잭션으로 묶었다. 실제 MySQL 충돌·롤백은 별도 검증이 필요하다.
- API 명세에 지원하는 주소 문법과 감사 기록 기준을 추가했다. DB 스키마 변경은 없다.

## 테스트

분리된 관리자 작업 폴더에서 Prisma Client 6.19.3 생성 및 TypeScript 전체 빌드가 통과했다. 다른 브랜치 Client는 변경하지 않았다. 증빙: evidence/admin-fixed-build.json. 실제 DB 연결이나 migration 적용은 하지 않았다.

별도 **19/19 통과**, 종료 코드 0. 이전 원본 7/9 결과를 보존했다. malformed CIDR 7종, 정상 subnet의 내부·외부 주소, 기존 관리자 권한·정지·탈퇴·프록시 위조, 감사 이전 값·기본값을 포함한다.

실제 Git 커밋의 admin 라우트와 helper를 변경 없이 메모리에서 변환하여 Express HTTP로 실행했다. 인증 주체·Prisma·트랜잭션·날짜는 mock이며 실제 JWT/DB 통합 또는 감사 영속성을 입증하지 않는다. 회귀 79개(72 통과·7 대기), 소셜 24개와 합산하지 않는다.

```powershell
$env:ADMIN_AUDIT_REVISION='826f293ce054d4b7cd1c6062d0cbc8238a00b0a0'
$env:ADMIN_AUDIT_FIXED='1'
node --test --test-reporter=tap infra/security/admin-route-audit.test.mjs
```

증빙: evidence/admin-fixed-route-audit.tap, evidence/admin-fixed-source-provenance.json. 새 구현 브랜치의 PR은 미병합 관리자 코드에 의존하므로 develop 대상 초안으로 제출한다. 관리자 담당 코드가 develop에 먼저 통합된 뒤 이 보안 변경 3개 파일만 남는지 확인하고 PR #13의 JWT·토큰 폐기·공용 속도 제한과 함께 통합해야 한다.

## 실제 통합 시험 준비 상태

현재 환경에서 docker/mysql/mysqld/mariadb 실행 도구를 찾지 못했다. 운영 DB에 접속하거나 migration·복원을 실행하지 않았다. 사진 업로드·원본 URL·스토리지 및 실제 백업 복구는 아직 검증할 실행 환경이 없다. 체크리스트의 실제 DB·사진·복구 7개 통합 대기는 완료 처리하지 않는다.
