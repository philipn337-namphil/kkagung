# KKAGUNG 프론트엔드 — Phase 2

해시 라우팅 기반의 정적 SPA입니다. 실제 API를 먼저 호출하며, API 서버가 연결되지 않았거나 아직 구현되지 않은 경로가 `501`을 반환할 때만 명시적으로 목업 데이터를 사용합니다. 실제 `404`는 숨기지 않고 화면에 표시합니다.

## 실행

Node.js 18 이상에서 실행합니다.

```powershell
cd frontend
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다. API 주소는 실행 전 `API_BASE_URL` 환경 변수로 바꿀 수 있습니다.

```powershell
$env:API_BASE_URL = 'http://localhost:8080'
npm run dev
```

## 구현 화면과 경로

| 화면 | 주소 | 상태 |
| --- | --- | --- |
| 로그인·테스트 계정 선택 | `#/login` | `/auth/login`, `/dev/test-accounts` 계약 사용 |
| 가입 | `#/signup` | `/auth/register` 계약 사용 |
| 프로필·선호 조건 | `#/profile` | `/me`, `/me/profile`, `/me/preferences` |
| 운세·오늘의 추천 | `#/home` | `/daily/open`, `/recommendations/today`, `/recommendations/refresh` |
| 추천 카드 상세·하트·채팅 요청 | `#/cards/{userId}` | 공개 카드만 표시 |
| 받은 하트·채팅 요청 | `#/inbox` | 하트, 수락·거절 UI |
| 채팅방·메시지 | `#/chats`, `#/chats/{roomId}` | 수락 후 화면 |
| 마이페이지·이미지 상태·차단 | `#/mypage`, `#/blocks` | 원본 사진 미표시 |
| 관리자 대시보드 | `#/admin` | 관리자 역할일 때만 접근 |

## API 처리 원칙

- `Authorization: Bearer {token}` 헤더를 API client 한 곳에서 붙입니다.
- Access Token은 소스 코드에 넣지 않으며, 현재 브라우저 세션에만 보관합니다.
- 로딩 상태, 성공 알림, `401`, `403`, `409`, `429`, 네트워크 오류를 화면에 표시합니다.
- 공개 카드에는 `publicImage.url`만 표시합니다. `originalImages`나 원본 object key는 추천·상세 카드 어디에도 사용하지 않습니다.
- 실제 사진 URL은 채팅방 상세에서 서버가 인증된 참여자에게 제공할 때만 사용할 수 있도록 API 계약을 분리했습니다. 현재 프론트 목업은 실제 사진 URL을 생성하거나 저장하지 않습니다.

## 백엔드 통합 시 확인할 점

현재 문서 계약의 구현 상태에 맞춰 API를 분리했습니다.

- 이미 연결 가능한 API: 인증, `/me`, 프로필·선호 조건, `/daily/open`, `/recommendations/today`, `/recommendations/refresh`, 개발용 테스트 계정 API
- 백엔드 구현 대기 API: 하트, 채팅 요청·채팅방·메시지, 차단·신고, 이미지 상태, 관리자 API
- 대기 API가 구현되면 `app.js`의 `api` 객체에서 해당 목업 fallback이 자동으로 실제 응답으로 바뀝니다. 응답 필드가 계약과 달라지면 `PublicCard`, 목록 `items`, `revealedProfile` 매핑을 함께 조정합니다.

## 수동 검증 기록

- 테스트 계정 로그인 → 운세·추천 카드 표시
- 하트와 추천 상세·추천 이유 표시
- 채팅 요청 입력 팝업 → 받은 요청 수락 → 채팅방 진입 → 메시지 전송
- 관리자 테스트 계정 → 운영 대시보드 표시
- 390px 너비에서 홈 화면의 가로 넘침 없음
- 카드·공개 화면에 원본 사진 URL 또는 object key 미노출

## 검사

```powershell
node --check frontend/app.js
git diff --check
```
