# 관리자 브랜치 보안 재검증

관리자 수정 최신 결과: [ADMIN_FIXES_20261025.md](ADMIN_FIXES_20261025.md). 별도 feature/security-admin-hardening에서 ADM-01/02를 수정하고 19/19 통과했다. JWT·DB·사진·실복구 통합 대기는 유지한다. 아래 관리자 7/9 결과는 수정 전 기록이다.


대상: feature/backend-admin cc021c7 (전체 SHA는 evidence/admin-source-provenance.json). 원본 Git 객체의 routes/admin.ts·lib/admin.ts를 변경 없이 메모리에서 변환하여 실제 Express HTTP로 실행했다. requireAuth의 주체·Prisma·트랜잭션·날짜는 fixture다. 실제 JWT·MySQL·감사 로그 영속성·롤백 검증이 아니다.

별도 **9개 중 7 통과 / 2 실패**, 종료 코드 1. 기존 보안 회귀 79개 및 소셜 24개와 합산하지 않는다.

확인한 보호: 현재 DB 일반 사용자와 정지·탈퇴·채팅 제한 관리자는 403, 운영 IP 목록 누락은 403, X-Forwarded-For 위조는 무시한다. 허용된 ACTIVE 관리자의 배지 설정 변경은 가짜 트랜잭션 콜백 안에서 설정 쓰기 3회와 감사 로그 생성 1회를 호출한다.

## ADM-01 / P2 — 빈 CIDR 접두사로 주소 제한 우회

담당: 백엔드 관리자(lib/admin.ts) + 인프라(ADMIN_ALLOWED_IP_CIDRS 검증).

재현: ADMIN_ALLOWED_IP_CIDRS를 `127.0.0.1/`로 설정하고 접속 주소 `192.0.2.2`에 isAllowedAddress를 호출한다. 기대 false, 실제 true. bitsRaw가 빈 문자열일 때 Number('')=0으로 변환되어 /0 마스크가 된다. 문법 오류를 거부해야 하는 설정이 전체 IPv4 허용으로 해석된다. CIDR 주소 옥텟 범위도 검증하지 않는다.

권장: 유효한 IP 파서 사용, `/` 한 개와 정수 prefix 0~32 검사, 옥텟 0~255 검사, 잘못된 목록 항목이 있으면 시작 실패. 명시적 /0을 허용할지도 운영 정책으로 결정한다. 관리자가 잘못 설정해야 발생하는 문제이며 원격 요청만으로 환경 변수 값을 바꿀 수 있다는 뜻은 아니다.

## ADM-02 / P2 — 배지 설정 감사 로그 변경 전 값 누락

담당: 백엔드 관리자(routes/admin.ts의 PUT /admin/settings/badge).

재현: 허용된 ACTIVE 관리자로 popularMinUniqueHearts=11, popularMinUniqueChatRequests=6, windowDays=30을 요청한다. 200 및 감사 로그 생성은 확인되지만 beforeValue가 undefined다. 설정 쓰기 전에 기존 유효 값 또는 기본값을 읽어 before/after를 같은 트랜잭션 안에서 기록해야 한다. 이미 설정을 덮어쓴 뒤에는 감사 로그만으로 원래 값을 복원할 수 없다.

설정 변경 성공 시 감사 기록 호출은 확인했지만, 실제 DB 트랜잭션 원자성·지속성·실패 롤백은 미검증이다. 위 문제는 승인된 인증·로그·프론트·채팅·보안 DB 수정 범위 밖의 새 관리자 코드라 이번에는 수정하지 않았다.

## 실행·증빙

```powershell
node --test --test-reporter=tap infra/security/admin-route-audit.test.mjs
```

evidence/admin-route-audit.tap과 admin-source-provenance.json에 결과·소스 해시를 저장했다. 해당 커밋이 로컬 Git 객체에 있어야 한다. 원본 사진·실제 계정·키·운영 DB를 사용하지 않았다.
