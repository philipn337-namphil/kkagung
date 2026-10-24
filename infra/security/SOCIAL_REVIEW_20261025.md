# 미병합 소셜 브랜치 보안 검증 (2026-10-25)

## 대상·방법

- 대상: feature/backend-social `64c27029008988acddb7a4978b5648142da0e109`.
- 기존 feature/security-ops 인증 수정과 develop에는 새 변경이 없어 기존 60개 결과를 유지했다. 다른 역할 브랜치를 병합하거나 수정하지 않았다.
- Git 객체의 chatRequests.ts·chatRooms.ts·hearts.ts를 읽고 TypeScript를 메모리에서 변환해 변경 없이 실행했다.
- 실제 Express HTTP 라우트만 검증했다. 인증 주체·Prisma·날짜·공개 카드 생성은 가짜 fixture다. JWT/실제 DB/추천 전체 흐름/트랜잭션 동시성 통합 검증이 아니다.
- **별도 16개 = 15 통과 / 1 실패**, 종료 코드 1. 기존 60개와 서로 다른 검증 범위이므로 합산 통과율을 만들지 않는다.

## 통과한 범위

- 양방향 차단 관계에서 신규 채팅 요청·메시지 전송 403, 변경 없음.
- 제3자와 발신자는 수신자를 대신해 요청을 수락할 수 없음.
- 차단되지 않은 수신자는 정상 수락, 참여자는 정상 메시지 전송 가능.
- 제3자의 채팅방/메시지 읽기·전송 거부.
- 정지 발신자, 탈퇴 수신 상대, 채팅 제한 발신자의 신규 메시지 거부.
- 차단 후 과거 메시지는 기존 참여자가 조회 가능.
- 차단된 방은 canSendMessage=false, originalImages=[], Cache-Control=no-store.

이 통과는 라우트 fixture 검증이다. 원본 이미지 서명·수락 후 실사진 접근이 완성됐다는 의미가 아니다. 대상 코드의 원본 배열은 아직 항상 빈 배열이다.

## SOC-01 / P2 — 수신자가 차단한 발신자의 기존 요청 수락 허용

담당: 백엔드 소셜(backend/src/routes/chatRequests.ts). 수정 위치는 대상 커밋 181~182행 및 수락 트랜잭션 경계다.

재현:

1. B(2)가 A(1)에게 보낸 PENDING 요청 11을 준비한다.
2. A가 B를 차단한 상태(blockerId=1, targetUserId=2)를 둔다.
3. A로 POST `/api/v1/chat-requests/11/accept`를 호출한다.
4. 기대: 403, 요청 상태·채팅방·참여자 변경 없음.
5. 실제: 201, 가짜 DB에서 요청 수락·방 생성·참여자 생성 3개 쓰기가 호출된다.

원인: 수락 전 차단 검사는 `blockerId=senderId, targetUserId=receiverId` 한 방향만 확인한다. A가 B를 차단한 반대 방향은 확인하지 않는다. 신규 요청·메시지는 양방향을 확인하므로 정책이 불일치한다.

영향: 차단 상태에서도 수락 상태 전이와 방 생성이 가능하다. 이후 메시지 전송은 별도 차단 검사로 거부되는 것을 확인했다. 실제 사진 유출을 관측했다는 뜻은 아니다.

권장 수정: 백엔드 담당이 양방향 차단을 확인하고, 수락/차단 동시 실행 시 정합성을 보장할 트랜잭션·잠금 순서를 검토한다. 기존 테스트에 '요청 수신 후 내가 발신자를 차단한 뒤 수락'을 추가한다. 이번 승인 범위는 인증 파일 3개이므로 이 채팅 코드는 수정하지 않았다.

## 인증 수정과 통합 시 주의

이 소셜 브랜치의 인증 미들웨어는 아직 이전 JWT 역할 기반이다. PR #13의 현재 DB 권한·상태 검사와 JWT 클레임 규칙을 보존해 통합해야 한다. 개발용 발급 토큰·기존 테스트 토큰도 새 iss/aud/jti/iat/exp 요구를 충족하도록 맞춰야 한다.

## 증빙·재실행

- `evidence/social-route-audit.tap`: 실제 16개 실행 결과. 실패는 201/3 writes, 기대는 403/0 writes.
- `evidence/social-source-provenance.json`: 대상 커밋과 실행한 원본 소스 해시.
- `social-route-audit.test.mjs`: 재현 fixture와 정확한 scope.

```powershell
git fetch origin feature/backend-social
node --test --test-reporter=tap infra/security/social-route-audit.test.mjs
```

backend 의존성(express·zod·TypeScript·Prisma Client)이 설치되어 있어야 한다. 원본 브랜치의 테스트는 실제 DB 시드 데이터를 변경하므로 이번에는 실행하지 않았다. 실제 사진·비밀번호·API 키는 사용하지 않았다.

## 유지되는 보류

실제 DB/트랜잭션·새 인증 미들웨어를 결합한 통합 시험, 사진 업로드·수락 후 원본 URL, 관리자 API·감사 로그, 실복구는 계속 미검증이다. 이 별도 검증으로 기존 7개 보류를 완료 처리하지 않는다.
