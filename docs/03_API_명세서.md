# API 명세서

## 공통 규칙

- Base URL: `/api/v1`
- 인증: `Authorization: Bearer {token}`
- 응답 시간은 ISO 8601 UTC로 전달하고 화면에서 한국 시간으로 변환한다.
- 실제 사진 URL은 수락된 채팅방 참여자만 받을 수 있다.
- `/admin` API는 `ADMIN` 역할만 호출한다.

```json
{ "success": true, "data": {}, "error": null }
```

실패 응답:

```json
{ "success": false, "data": null, "error": { "code": "REFRESH_TOKEN_EXPIRED", "message": "새로고침권 사용 시간이 지났습니다." } }
```

## 인증·프로필

| Method | Path | 설명 |
|---|---|---|
| POST | `/auth/register` | 계정 생성·성인 인증 시작 |
| POST | `/auth/login` | 로그인·토큰 발급 |
| POST | `/auth/logout` | 세션 종료 |
| GET | `/me` | 내 계정·프로필 요약 |
| PUT | `/me/profile` | 프로필 수정 |
| PUT | `/me/preferences` | 선호 조건 수정 |
| POST | `/me/images` | 원본 사진 업로드·공개 이미지 생성 요청 |
| GET | `/me/images/status` | 이미지 생성 상태 |
| GET/POST/DELETE | `/me/blocks[/{targetUserId}]` | 차단 목록·차단·해제 |

## 운세·추천

| Method | Path | 설명 |
|---|---|---|
| POST | `/daily/open` | 운세 조회, 선착순권 지급 시도, 홈 데이터 |
| GET | `/daily` | 오늘 운세·새로고침권 상태 |
| GET | `/recommendations/today` | 당일 추천 카드 |
| POST | `/recommendations/refresh` | 새로고침권으로 새 카드 생성 |
| GET | `/cards/{targetUserId}` | 추천 카드 상세 |

`POST /daily/open`은 당일 여러 번 요청해도 같은 운세를 반환한다. 선착순권은 최초 유효 호출에서만 트랜잭션으로 지급한다.

## 하트·채팅

| Method | Path | 설명 |
|---|---|---|
| POST/DELETE | `/cards/{targetUserId}/hearts` | 하트 추가·취소 |
| GET | `/hearts/received` | 받은 하트 |
| POST | `/chat-requests` | 채팅 요청 생성 |
| GET | `/chat-requests/received` | 받은 요청 |
| GET | `/chat-requests/sent` | 보낸 요청 |
| POST | `/chat-requests/{requestId}/accept` | 수락·채팅방 생성·상호 공개 |
| POST | `/chat-requests/{requestId}/reject` | 거절 |
| GET | `/chat-rooms` | 내 채팅방 |
| GET | `/chat-rooms/{roomId}` | 채팅방·수락 후 프로필 |
| GET/POST | `/chat-rooms/{roomId}/messages` | 메시지 조회·전송 |

채팅 요청은 그날(기본 또는 새로고침) 상대에게 노출된 카드에만 보낼 수 있다. 차단·제재·대기 중복 요청은 거절한다.

## 신고·관리자

| Method | Path | 설명 |
|---|---|---|
| POST | `/reports` | 사용자·메시지 신고 |
| GET | `/admin/dashboard` | 운영 지표 |
| GET | `/admin/users` | 사용자 목록 |
| PATCH | `/admin/users/{userId}/sanction` | 제재 변경 |
| GET/PATCH | `/admin/reports[/{reportId}]` | 신고 목록·처리 |
| GET | `/admin/settings` | 설정 조회 |
| PUT | `/admin/settings/badge` | 배지 기준 변경 |
| PUT | `/admin/settings/daily-refresh` | 다음 일자 선착순 N 변경 |
| GET | `/admin/statistics/daily` | 일별 통계 |

## 주요 오류 코드

| 코드 | HTTP | 의미 |
|---|---:|---|
| `UNAUTHORIZED` | 401 | 로그인·토큰 검증 실패 |
| `FORBIDDEN` | 403 | 역할·공개 단계 권한 없음 |
| `RECOMMENDATION_NOT_FOUND` | 404 | 오늘 노출되지 않은 카드 |
| `REFRESH_TOKEN_NOT_FOUND` | 404 | 새로고침권 없음 |
| `REFRESH_TOKEN_EXPIRED` | 409 | 새로고침권 만료 |
| `REFRESH_TOKEN_ALREADY_USED` | 409 | 이미 사용 |
| `CHAT_REQUEST_ALREADY_PENDING` | 409 | 대기 중 중복 요청 |
