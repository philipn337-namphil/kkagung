# API 명세서

Phase 2 백엔드 API 계약서이다. 프론트엔드는 이 문서를 기준으로 화면을 연결한다.

## 구현 상태 표기

| 표기 | 의미 |
|---|---|
| ✅ | 이미 구현됨. 현재 코드에서 동작한다. |
| 🔜 | Phase 2에 백엔드가 구현한다. |
| ⏳ | 담당·시점 미정. 계약만 먼저 확정한 상태이며 호출하면 아직 없는 경로다. |

구현 상태는 `backend/src`, `backend/prisma`를 직접 확인해 판정했다. 상태가 바뀌면 같은 PR에서 이 표기도 수정한다.

## 공통 규칙

- Base URL: `/api/v1`
- 인증: `Authorization: Bearer {token}`
- 토큰 유효 기간은 `JWT_EXPIRES_IN` 환경별 설정값이며 기본은 개발 `12h`, 운영(`NODE_ENV=production` 또는 `APP_ENV=production`) `900s`다. 값은 `900s`, `15m`, `12h`처럼 양의 정수와 단위(s/m/h/d)로 지정한다.
- JWT는 HS256만 허용한다. `sub`·`iat`·`exp`·`iss`·`aud`·`jti`를 발급하며 필수 클레임·서명·만료·발급자·대상을 검증한다. 기존 필수 클레임 없는 토큰은 401이므로 배포 후 다시 로그인해야 한다.
- JWT 역할(`USER`/`ADMIN`)은 호환용 정보다. 권한은 매 요청 현재 DB의 계정 역할·상태·성인 인증 여부로 결정한다. 삭제 계정은 401, 정지·탈퇴 계정은 403, 성인 인증 미완료는 `403 ADULT_VERIFICATION_REQUIRED`다.
- 로그인에서도 정지·탈퇴·성인 인증 미완료 계정을 차단한다. `RECOMMENDATION_BLOCKED`·`CHAT_RESTRICTED`는 전체 로그인 금지가 아니며 해당 기능 API에서 추가 제한해야 한다.
- 관리자 계정으로 보호 API에 접근하려면 `ACTIVE` 상태여야 한다. 일반 사용자의 추천·채팅 부분 제재는 전체 인증 접근을 차단하지 않는다.
- 시작 전 `JWT_SECRET`은 비공개 난수 문자열 최소 32 UTF-8 바이트로 설정한다. 빈 값·짧은 값·공개된 기본 예시 키는 개발/운영 모두 거부한다. 새 환경 변수와 기존 AUTH_ACCESS_TOKEN_TTL_SECONDS가 함께 있으면 인증 만료 설정은 `JWT_EXPIRES_IN`을 사용한다.
- 로그아웃 성공 시 해당 JWT의 SHA-256 해시를 DB 폐기 목록에 저장한다. 이후 동일 토큰은 401이며 다른 로그인 토큰은 유지한다. DB 장애 시 폐기 성공을 반환하지 않는다.
- 운영(`NODE_ENV=production` 또는 `APP_ENV=production`) 신규 가입은 실제 성인 인증 제공자 연동 전까지 `403 ADULT_VERIFICATION_REQUIRED`로 거부한다. 개발 가입의 `adultVerified=true`는 테스트 전용이며 실제 성인 인증이 아니다. 어느 환경 변수든 production이면 기본 JWT TTL도 900s다.
- 응답 시각은 ISO 8601 UTC(`Z`)로 전달하고 화면에서 한국 시간으로 변환한다.
- 실제 사진 URL은 수락된 채팅방 참여자만 받을 수 있다.
- `/admin` API는 `ADMIN` 역할만 호출한다.
- 모든 숫자 ID는 응답에서 문자열로 전달한다. DB가 `BIGINT`여서 JavaScript 정수 범위를 넘을 수 있다.

### 성공·실패 응답 형식

```json
{ "success": true, "data": {}, "error": null }
```

실패 응답:

```json
{ "success": false, "data": null, "error": { "code": "REFRESH_TOKEN_EXPIRED", "message": "새로고침권 사용 시간이 지났습니다." } }
```

### 서비스 날짜

- 서비스 하루는 한국 시간(`Asia/Seoul`) 오전 8시부터 다음 날 오전 8시 직전까지다.
- 오전 8시 이전 요청은 **전날** 서비스 날짜에 속한다. 예: KST `10-27 07:30` 요청의 `serviceDate`는 `2026-10-26`이다.
- 응답의 `serviceDate`는 `YYYY-MM-DD` 문자열이며 KST 기준 날짜다. 그 외 모든 시각 필드는 UTC `Z`다.
- 클라이언트가 보낸 날짜·시간대를 신뢰하지 않는다. 서비스 날짜는 서버가 계산한다.

### 목록 응답 형식

목록을 반환하는 모든 API는 커서 방식 페이지네이션을 사용한다.

요청 쿼리: `?cursor={nextCursor}&limit={1~50}` (`limit` 기본값 20, `cursor` 생략 시 첫 페이지)

```json
{
  "success": true,
  "data": {
    "items": [],
    "nextCursor": "eyJpZCI6IjEwMiJ9",
    "hasMore": true
  },
  "error": null
}
```

- `nextCursor`는 불투명한 문자열이다. 클라이언트는 해석하지 않고 그대로 다음 요청에 넣는다.
- 마지막 페이지에서는 `nextCursor`가 `null`, `hasMore`가 `false`다.
- 총 개수(`totalCount`)는 제공하지 않는다. 대량 집계 비용을 피하기 위함이며, 필요한 화면은 관리자 통계 API를 사용한다.

### 목록에서 제외되는 상대

다음 조건에 해당하는 상대는 추천 카드, 받은 하트, 받은·보낸 채팅 요청, 채팅방 목록 **어디에도 나오지 않는다.**

- 내가 차단한 사용자, 나를 차단한 사용자
- 계정 상태가 `SUSPENDED`(이용 정지) 또는 `WITHDRAWN`(탈퇴)인 사용자
- 추천 목록에서는 `RECOMMENDATION_BLOCKED`(추천 제외 제재) 사용자도 제외한다

이미 생성된 채팅방의 과거 메시지는 차단 후에도 기존 참여자가 조회할 수 있으나, 신규 메시지 전송과 상대 실제 사진 조회는 차단된다.

### 멱등성

같은 요청을 반복해도 결과가 같은지 여부를 각 API에 `반복 호출` 항목으로 적는다.

- `멱등`: 몇 번 호출해도 상태가 한 번만 바뀌고 같은 응답을 준다.
- `비멱등`: 호출마다 새 자원이 생기거나 상태가 또 바뀐다.

### 속도 제한

- DB 공용 고정 시간 창 카운터: `/api` 전체는 직접 연결 IP별 90회/60초, 로그인은 직접 연결 IP별 및 정규화 이메일별 각각 10회/900초, 가입은 IP별 10회/900초다. 로그인은 실패뿐 아니라 성공 시도도 센다.
- 제한 초과 시 `429 TOO_MANY_REQUESTS`, `Retry-After`(초), `Cache-Control: no-store`를 반환한다. 저장소 장애 시 500이며 메모리 제한으로 우회하지 않는다.
- `X-Forwarded-For`는 사용하지 않는다. 리버스 프록시 경유 시 현재는 프록시 주소 전체가 같은 한도를 공유한다. 인프라의 접속 경계 합의 전 임의로 trust proxy를 켜지 않는다. 향후 통합될 `/api/v1/admin`도 공통 제한을 거쳐야 한다.
- 고정 시간 창 경계에서는 인접 두 창의 한도만큼 순간 요청이 허용될 수 있다. 실제 DB 부하·다중 인스턴스·동시 생성 경합 시험은 배포 전 필수다.

## 공통 응답 객체

### PublicCard — 공개 카드

추천 카드, 받은 하트 발신자, 받은·보낸 채팅 요청 상대에 **모두 같은 모양**으로 쓰인다.

```json
{
  "userId": "1042",
  "displayName": "서윤",
  "age": 27,
  "gender": "FEMALE",
  "regionLabel": "서울 마포구",
  "heightCm": 164,
  "jobCategory": "OFFICE_WORKER",
  "mbti": "ENFP",
  "animalFace": "고양이상",
  "badges": ["POPULAR"],
  "publicImage": {
    "url": "https://kkagung-profile-public.example/profiles/ai/8f3c.../a91e.webp",
    "type": "AI_PUBLIC"
  },
  "recommendReason": "선호 지역과 나이 조건이 일치해요."
}
```

보안 규칙 — 이 객체에 **절대 포함되지 않는 것**:

- 원본 사진 URL, 원본 object key, 원본 버킷명
- 이메일, 생년월일 전체 값(나이만 제공), 전화번호
- 동 단위 주소(구 단위 `regionLabel`만 제공)
- 한 줄 소개, 취미, 흡연·문신·군필, 닮은 연예인 등 상세 프로필
- 하트·채팅 요청 수치(`badges`는 부여 여부만 표기하고 수치는 노출하지 않는다)

`publicImage.type`은 `AI_PUBLIC` 또는 `BLURRED_PUBLIC`이다. AI 변환 실패 시 흐림 이미지를 쓰며, 둘 다 실패하면 `publicImage`는 `null`이고 화면은 대체 도형을 표시한다. 원본 사진을 대신 보내지 않는다.

### RevealedProfile — 수락 후 공개 프로필

**수락된 채팅방의 두 참여자에게만** 반환된다. 다른 어떤 API도 이 객체를 반환하지 않는다.

```json
{
  "userId": "1042",
  "displayName": "서윤",
  "age": 27,
  "gender": "FEMALE",
  "regionLabel": "서울 마포구",
  "heightCm": 164,
  "jobCategory": "OFFICE_WORKER",
  "mbti": "ENFP",
  "intro": "전시와 산책, 맛있는 커피를 좋아해요.",
  "hobbies": ["EXHIBITION", "WALKING"],
  "smokingStatus": "NON_SMOKER",
  "tattooStatus": "NO",
  "militaryService": "NOT_APPLICABLE",
  "celebrityLookalike": "비공개",
  "originalImages": [
    {
      "imageId": "9931",
      "url": "https://kkagung-original-private.example/originals/8f3c.../a91e.jpg?X-Amz-Expires=60&...",
      "expiresAt": "2026-10-27T02:01:00Z"
    }
  ]
}
```

- `originalImages[].url`은 **최대 60초** 유효한 임시 URL이다. 응답 헤더에 `Cache-Control: no-store`를 붙인다.
- 화면은 이 URL을 저장·재사용하지 않고 만료되면 채팅방을 다시 조회한다.
- 차단·정지·탈퇴가 발생하면 신규 URL 발급을 중단한다. 이미 발급된 URL은 만료까지 유효하며 회수할 수 없다.
- object key는 응답에 넣지 않는다.

## 오류 코드

### 공통 (모든 API)

| 코드 | HTTP | 의미 |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | 요청 본문·쿼리 형식이 올바르지 않음 |
| `UNAUTHORIZED` | 401 | 토큰 누락·위조·만료 |
| `FORBIDDEN` | 403 | 역할·공개 단계 권한 없음 |
| `SUSPENDED_USER` | 403 | 이용 정지된 계정 |
| `RESOURCE_NOT_FOUND` | 404 | 경로 또는 대상 없음 |
| `TOO_MANY_REQUESTS` | 429 | 속도 제한 초과 |
| `INTERNAL_SERVER_ERROR` | 500 | 서버 오류 |
| `NOT_IMPLEMENTED` | 501 | 계약만 있고 아직 구현되지 않은 경로 |

### 기능별

| 코드 | HTTP | 의미 |
|---|---:|---|
| `EMAIL_ALREADY_EXISTS` | 409 | 이미 가입된 이메일 |
| `INVALID_CREDENTIALS` | 401 | 이메일 또는 비밀번호 불일치 |
| `PROFILE_INCOMPLETE` | 409 | 프로필·선호 조건 미등록 상태에서 추천·상호작용 요청 |
| `RECOMMENDATION_NOT_FOUND` | 404 | 오늘 노출되지 않은 카드 |
| `REFRESH_TOKEN_NOT_FOUND` | 404 | 새로고침권 없음 |
| `REFRESH_TOKEN_EXPIRED` | 409 | 새로고침권 만료 |
| `REFRESH_TOKEN_ALREADY_USED` | 409 | 이미 사용 |
| `SELF_ACTION_NOT_ALLOWED` | 400 | 자신을 대상으로 한 하트·요청·차단·신고 |
| `TARGET_BLOCKED` | 403 | 내가 차단한 상대 |
| `BLOCKED_BY_TARGET` | 403 | 나를 차단한 상대 |
| `TARGET_UNAVAILABLE` | 403 | 상대가 정지·탈퇴·추천 제외 상태 |
| `HEART_ALREADY_SENT` | 409 | 중복 하트 |
| `HEART_NOT_FOUND` | 404 | 취소할 하트가 없음 |
| `CHAT_REQUEST_ALREADY_PENDING` | 409 | 대기 중 중복 요청 |
| `CHAT_REQUEST_NOT_FOUND` | 404 | 요청 없음 또는 내 요청이 아님 |
| `CHAT_REQUEST_ALREADY_RESOLVED` | 409 | 이미 수락·거절·무시 처리됨 |
| `CHAT_REQUEST_NOT_ALLOWED` | 403 | 오늘 노출된 카드도, 받은 하트 발신자도 아닌 상대 |
| `CHAT_ROOM_NOT_FOUND` | 404 | 채팅방 없음 |
| `NOT_ROOM_MEMBER` | 403 | 채팅방 참여자가 아님 |
| `CHAT_RESTRICTED` | 403 | 채팅 제한 제재 상태 |
| `BLOCK_NOT_FOUND` | 404 | 해제할 차단이 없음 |
| `REPORT_ALREADY_EXISTS` | 409 | 같은 대상·사유로 처리 대기 중인 신고가 있음 |
| `IMAGE_LIMIT_EXCEEDED` | 409 | 사진 최대 3장 초과 |
| `IMAGE_TOO_LARGE` | 413 | 업로드 용량·픽셀 한도 초과 |
| `UNSUPPORTED_IMAGE_TYPE` | 415 | 허용되지 않은 파일 형식 |
| `IMAGE_PROCESSING_FAILED` | 409 | AI·흐림 변환 모두 실패 |
| `SETTING_NOT_ALLOWED` | 400 | 관리자 설정 허용 범위를 벗어난 값 |

개발 전용 경로가 비활성 상태일 때는 전용 오류 코드를 쓰지 않고 `RESOURCE_NOT_FOUND`(404)를 반환한다. 경로의 존재 자체를 노출하지 않기 위함이다.

## 1. 인증

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| POST | `/auth/register` | 공개 | ✅ |
| POST | `/auth/login` | 공개 | ✅ |
| POST | `/auth/logout` | 로그인 | ✅ |

### POST `/auth/register` ✅

개발 환경에서만 테스트 계정 생성 후 토큰을 발급한다. 운영은 제공자 기반 성인 인증 연동 전까지 사용자 생성 없이 403으로 차단한다.

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `email` | string | 필수 | 이메일 형식 |
| `password` | string | 필수 | 8자 이상 |
| `adultVerified` | boolean | 필수 | `true`만 허용 |

```json
{ "email": "me@example.com", "password": "password123!", "adultVerified": true }
```

성공 `201`:

```json
{ "success": true, "data": { "token": "eyJhbGciOi...", "user": { "id": "7", "email": "me@example.com", "role": "USER" } }, "error": null }
```

- 오류: `VALIDATION_ERROR` 400, `EMAIL_ALREADY_EXISTS` 409, `ADULT_VERIFICATION_REQUIRED` 403(운영 가입 차단), `TOO_MANY_REQUESTS` 429
- 특별 규칙: 요청 본문의 `role`, `status`, `adultVerifiedAt`은 무시한다. 사용자가 관리자 권한을 만들 수 없다.
- 반복 호출: 비멱등. 두 번째 호출은 `EMAIL_ALREADY_EXISTS`.

### POST `/auth/login` ✅

| 필드 | 타입 | 필수 |
|---|---|---|
| `email` | string | 필수 |
| `password` | string | 필수 |

성공 `200`: `register`와 같은 모양(`token`, `user`).

- 오류: `VALIDATION_ERROR` 400, `INVALID_CREDENTIALS` 401, `SUSPENDED_USER` 403, `FORBIDDEN` 403(탈퇴), `ADULT_VERIFICATION_REQUIRED` 403(성인 인증 미완료), `TOO_MANY_REQUESTS` 429
- 특별 규칙: 이메일이 없는 경우와 비밀번호가 틀린 경우를 구분하지 않고 둘 다 `INVALID_CREDENTIALS`로 응답한다. 가입 여부를 알아내지 못하게 하기 위함이다.
- 반복 호출: 멱등(상태 변화는 `lastActiveAt` 갱신뿐).

### POST `/auth/logout` ✅

본문 없음. 성공 `200`:

```json
{ "success": true, "data": { "message": "로그아웃되었습니다. 클라이언트 토큰을 삭제해 주세요." }, "error": null }
```

- 특별 규칙: 인증된 토큰만 폐기한다. 원문 토큰은 저장하지 않는다. 프론트는 서버 성공 응답 후 로컬 토큰을 삭제하며 저장 실패 시 재시도한다.
- 오류: `UNAUTHORIZED` 401(누락·만료·이미 폐기), `FORBIDDEN` 403(계정 상태), `TOO_MANY_REQUESTS` 429, 저장소 장애 500.
- 반복 호출: 첫 요청 성공 후 동일 토큰 재호출은 401. 폐기 상태는 유지된다.

## 2. 테스트 계정 (개발·시연 전용)

Phase 1에서 빠졌던 3개다. **운영 환경에서는 비활성이며 호출하면 `RESOURCE_NOT_FOUND`(404)를 반환한다.**

활성 조건: `APP_ENV`가 `production`이 아니고, 별도 플래그 환경 변수가 켜져 있을 때만 라우터를 등록한다. 플래그 이름은 `.env.example`이 공용 파일이므로 인프라 담당과 확정한 뒤 추가한다.

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| GET | `/dev/test-accounts` | 공개(개발 환경) | 🔜 |
| POST | `/dev/test-accounts/{accountId}/token` | 공개(개발 환경) | 🔜 |
| POST | `/dev/test-accounts/reseed` | 공개(개발 환경) | 🔜 |

### GET `/dev/test-accounts` 🔜

로그인 화면에서 "테스트 계정으로 접속" 목록을 그리기 위한 API다.

성공 `200` — 목록 응답 형식을 쓰지 않고 전체를 한 번에 반환한다(시드 계정은 수십 개로 고정).

```json
{
  "success": true,
  "data": {
    "accounts": [
      { "accountId": "1", "email": "admin@kkagung.local", "role": "ADMIN", "displayName": "관리자", "gender": null, "age": null, "profileCompleted": false },
      { "accountId": "2", "email": "user01@kkagung.local", "role": "USER", "displayName": "서윤", "gender": "FEMALE", "age": 27, "profileCompleted": true }
    ]
  },
  "error": null
}
```

- 오류: `RESOURCE_NOT_FOUND` 404(운영 환경)
- 특별 규칙: 비밀번호·해시는 절대 반환하지 않는다. 시드로 만든 계정만 반환하며 실제 가입자는 포함하지 않는다. 판별은 시드 전용 이메일 도메인(`@kkagung.local`)으로 한다. 이 방식은 `users` 테이블에 새 컬럼을 추가하지 않으므로 ERD 변경이 필요 없다.
- 반복 호출: 멱등.

### POST `/dev/test-accounts/{accountId}/token` 🔜

목록에서 계정을 골라 비밀번호 입력 없이 토큰을 받는다.

본문 없음. 성공 `200`: `/auth/login`과 **같은 모양**(`token`, `user`). 프론트는 로그인과 동일한 처리 흐름을 쓸 수 있다.

- 오류: `RESOURCE_NOT_FOUND` 404(운영 환경 또는 없는 계정), `SUSPENDED_USER` 403
- 특별 규칙: 시드 전용 이메일 도메인 계정만 허용한다. 실제 가입자 ID를 넣으면 `RESOURCE_NOT_FOUND`로 거부한다.
- 반복 호출: 멱등(호출마다 새 토큰이 발급되지만 계정 상태는 바뀌지 않는다).

### POST `/dev/test-accounts/reseed` 🔜

시연 중 데이터가 더럽혀졌을 때 시드 상태로 되돌린다.

본문 없음. 성공 `200`:

```json
{ "success": true, "data": { "reseeded": true, "accountCount": 8, "serviceDate": "2026-10-27" }, "error": null }
```

- 오류: `RESOURCE_NOT_FOUND` 404(운영 환경)
- 특별 규칙: **시드 계정이 만든 데이터만** 지운다(하트, 채팅 요청, 채팅방, 메시지, 신고, 차단, 당일 운세·추천·새로고침권). 실제 가입자 데이터는 건드리지 않는다. 운영 환경에서는 라우터 자체가 등록되지 않으므로 사고로 호출될 수 없다.
- 반복 호출: 멱등.

## 3. 내 정보·프로필·선호 조건

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| GET | `/me` | 로그인 | ✅ |
| PUT | `/me/profile` | 로그인 | ✅ |
| PUT | `/me/preferences` | 로그인 | ✅ |
| DELETE | `/me` | 로그인 | ⏳ |

### GET `/me` ✅

내 계정 + 프로필 + 선호 조건을 한 번에 반환한다. 프론트는 이 하나로 마이페이지를 그린다.

성공 `200`:

```json
{
  "success": true,
  "data": {
    "id": "7",
    "email": "me@example.com",
    "role": "USER",
    "status": "ACTIVE",
    "adultVerifiedAt": "2026-10-23T05:21:00Z",
    "profile": { "userId": "7", "displayName": "민상", "birthDate": "2000-01-01T00:00:00Z", "gender": "MALE", "regionCode": "SEOUL_DONGDAEMUN", "heightCm": 175, "jobCategory": "STUDENT", "mbti": "INTJ", "energyType": null, "animalFace": null, "celebrityLookalike": null, "smokingStatus": null, "tattooStatus": null, "militaryService": null, "intro": null, "profileCompletedAt": "2026-10-23T05:30:00Z" },
    "preference": { "userId": "7", "preferredGender": "FEMALE", "minAge": 20, "maxAge": 35, "regionScope": ["SEOUL_DONGDAEMUN"], "energyType": "ANY", "animalFace": null, "minHeightCm": null, "smokingStatus": "ANY", "tattooStatus": "ANY", "militaryService": "ANY" }
  },
  "error": null
}
```

- `profile`, `preference`는 미등록이면 `null`이다.
- 오류: `UNAUTHORIZED` 401
- 특별 규칙: 비밀번호 해시는 포함하지 않는다. 본인 정보이므로 `birthDate`를 그대로 제공한다(타인 카드에는 `age`만 제공).
- 반복 호출: 멱등.

### PUT `/me/profile` ✅

프로필 생성·수정을 겸한다(없으면 만들고 있으면 덮어쓴다).

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `displayName` | string | 필수 | 1~30자 |
| `birthDate` | string | 필수 | `YYYY-MM-DD` |
| `gender` | enum | 필수 | `MALE` `FEMALE` `OTHER` |
| `regionCode` | string | 필수 | 1~50자 |
| `heightCm` | number | 필수 | 정수 100~250 |
| `jobCategory` | enum | 필수 | `STUDENT` `OFFICE_WORKER` `FREELANCER` `SELF_EMPLOYED` `OTHER` |
| `mbti` | string | 필수 | 4자, `[EI][NS][FT][JP]` 패턴 |
| `energyType` | enum 또는 null | 선택 | `EGEN` `TETO` |
| `animalFace` | string 또는 null | 선택 | 최대 30자 |
| `celebrityLookalike` | string 또는 null | 선택 | 최대 50자 |
| `smokingStatus` | enum 또는 null | 선택 | `SMOKER` `NON_SMOKER` |
| `tattooStatus` | enum 또는 null | 선택 | `YES` `NO` |
| `militaryService` | enum 또는 null | 선택 | `COMPLETED` `NOT_COMPLETED` `NOT_APPLICABLE` |
| `intro` | string 또는 null | 선택 | 최대 200자 |

성공 `200`: 저장된 프로필 객체(`GET /me`의 `profile`과 같은 모양).

- 오류: `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401
- 특별 규칙: `ANY`는 **선호 조건에서만** 쓰는 값이다. 내 프로필에는 `ANY`를 넣을 수 없다.
- 반복 호출: 멱등.

### PUT `/me/preferences` ✅

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `preferredGender` | enum | 필수 | `MALE` `FEMALE` `OTHER` |
| `minAge` | number | 필수 | 정수 19~99 |
| `maxAge` | number | 필수 | 정수 19~99, `minAge` 이상 |
| `regionScope` | string 배열 | 필수 | 1개 이상, 각 최대 50자 |
| `energyType` | enum | 선택 | 기본 `ANY` |
| `animalFace` | string 또는 null | 선택 | 최대 30자 |
| `minHeightCm` | number 또는 null | 선택 | 정수 100~250 |
| `smokingStatus` | enum | 선택 | 기본 `ANY` |
| `tattooStatus` | enum | 선택 | 기본 `ANY` |
| `militaryService` | enum | 선택 | 기본 `ANY` |

성공 `200`: 저장된 선호 조건 객체.

- 오류: `VALIDATION_ERROR` 400(`minAge > maxAge` 포함), `UNAUTHORIZED` 401
- 특별 규칙: 성별·나이는 `ANY`를 허용하지 않는다. 그 외 조건은 `ANY`로 "상관없음"을 표현한다.
- 반복 호출: 멱등.

### DELETE `/me` ⏳

탈퇴. 마이페이지 화면 정의에 있으나 담당·시점 미정이다.

본문 없음. 성공 `200`:

```json
{ "success": true, "data": { "status": "WITHDRAWN", "withdrawnAt": "2026-10-27T02:00:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401
- 특별 규칙: 계정을 삭제하지 않고 `status`를 `WITHDRAWN`으로 바꾼다. 즉시 모든 목록에서 제외되고 원본 사진 신규 URL 발급이 중단된다. 개인정보 완전 삭제 기준과 보관 기간은 보안·운영 담당과 확정해야 한다.
- 반복 호출: 멱등.

## 4. 사진 업로드·처리 상태

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| GET | `/me/images` | 로그인 | ⏳ |
| POST | `/me/images` | 로그인 | ⏳ |
| DELETE | `/me/images/{imageId}` | 로그인 | ⏳ |
| GET | `/me/images/status` | 로그인 | 경로만 존재. 현재 `NOT_IMPLEMENTED` 501 반환 |

### GET `/me/images` ⏳

내 사진 목록. 본인이므로 자신의 원본은 조회할 수 있다.

```json
{
  "success": true,
  "data": {
    "images": [
      { "imageId": "9931", "slot": 1, "generationStatus": "DONE", "publicUrl": "https://example-public/profiles/ai/8f3c/a91e.webp", "publicType": "AI_PUBLIC", "originalUrl": "https://example-private/originals/8f3c/a91e.jpg?expires=60", "originalUrlExpiresAt": "2026-10-27T02:01:00Z", "uploadedAt": "2026-10-26T23:40:00Z" }
    ]
  },
  "error": null
}
```

- `generationStatus`: `PENDING` `PROCESSING` `DONE` `FAILED`
- 오류: `UNAUTHORIZED` 401
- 특별 규칙: `originalUrl`은 **본인 요청에만** 포함되고 60초 만료다. object key는 반환하지 않는다. 응답에 `Cache-Control: no-store`를 붙인다.
- 반복 호출: 멱등.

### POST `/me/images` ⏳

원본 사진 업로드. `multipart/form-data`로 전송한다.

| 파트 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `file` | file | 필수 | `image/jpeg` `image/png` `image/webp`, 최대 10MB, 최대 2천만 픽셀 |
| `slot` | number | 선택 | 1~3. 생략 시 빈 자리에 배치 |

성공 `202`(처리 시작):

```json
{ "success": true, "data": { "imageId": "9932", "slot": 2, "generationStatus": "PENDING" }, "error": null }
```

- 오류: `VALIDATION_ERROR` 400, `IMAGE_LIMIT_EXCEEDED` 409, `IMAGE_TOO_LARGE` 413, `UNSUPPORTED_IMAGE_TYPE` 415
- 특별 규칙: 클라이언트가 보낸 버킷·object key·이미지 종류를 신뢰하지 않는다. 서버가 경로를 정하고 실제 파일 형식을 검사하며 위치 정보 등 메타데이터를 제거한다. 원본은 비공개 버킷에만 저장한다. 사진은 최대 3장이다.
- 반복 호출: 비멱등. 호출마다 새 사진이 추가된다.

### DELETE `/me/images/{imageId}` ⏳

성공 `200`:

```json
{ "success": true, "data": { "deleted": true, "imageId": "9932" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `RESOURCE_NOT_FOUND` 404(내 사진이 아니거나 없음)
- 반복 호출: 멱등.

### GET `/me/images/status`

AI·흐림 변환 진행 상태만 확인한다. 프로필 등록 화면이 완료를 기다릴 때 사용한다.

성공 `200`:

```json
{ "success": true, "data": { "items": [ { "imageId": "9931", "generationStatus": "DONE" }, { "imageId": "9932", "generationStatus": "PROCESSING" } ], "allDone": false }, "error": null }
```

- 오류: 현재 구현은 항상 `NOT_IMPLEMENTED` 501을 반환한다. 구현 후에는 `UNAUTHORIZED` 401만 남는다.
- 특별 규칙: AI 변환이 실패하면 흐림 이미지로 대체해 `DONE`이 된다. 흐림까지 실패하면 `FAILED`이며 화면은 재업로드를 안내한다. 원본을 대신 공개하지 않는다.
- 반복 호출: 멱등.

## 5. 오늘의 운세·추천 카드·새로고침권

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| POST | `/daily/open` | 로그인 | 🔜 |
| GET | `/daily` | 로그인 | 🔜 |
| GET | `/recommendations/today` | 로그인 | 🔜 |
| POST | `/recommendations/refresh` | 로그인 | 🔜 |
| GET | `/cards/{targetUserId}` | 로그인 | 🔜 |

### POST `/daily/open` 🔜

홈 진입 시 첫 호출. 운세를 공개하고 선착순 새로고침권 지급을 시도한 뒤 홈 데이터를 돌려준다.

본문 없음. 성공 `200`:

```json
{
  "success": true,
  "data": {
    "serviceDate": "2026-10-27",
    "fortune": {
      "grade": "GOOD",
      "score": 78,
      "cardCount": 5,
      "message": "가까운 거리에서 좋은 인연이 기다려요.",
      "openedAt": "2026-10-26T23:02:11Z"
    },
    "refreshTicket": {
      "status": "AVAILABLE",
      "granted": true,
      "expiresAt": "2026-10-27T23:00:00Z"
    },
    "cards": [],
    "firstOpen": true
  },
  "error": null
}
```

- `fortune.grade`: `BAD` `NORMAL` `GOOD` `GREAT`. 등급에 따라 `cardCount`가 3·5·7이 된다.
- `refreshTicket.status`: `AVAILABLE`(사용 가능) `USED`(사용함) `EXPIRED`(만료) `NOT_GRANTED`(미당첨)
- `refreshTicket.granted`: **이번 호출에서** 새로 지급했는지 여부. 두 번째 호출부터는 `false`.
- `cards`: `PublicCard` 배열. `fortune.cardCount`개.
- 오류: `UNAUTHORIZED` 401, `PROFILE_INCOMPLETE` 409(프로필 또는 선호 조건 미등록), `TOO_MANY_REQUESTS` 429
- 특별 규칙:
  - 같은 서비스 날짜에 몇 번 호출해도 **같은 운세와 같은 카드**를 반환한다. `openedAt`도 최초 호출 시각으로 고정된다.
  - 새로고침권은 **최초 유효 호출에서만** 지급한다. 재고 차감은 DB 트랜잭션으로 처리하며, 동시 요청에도 설정한 N개를 넘겨 발급하지 않는다.
  - 재고가 소진됐으면 오류가 아니라 `status`를 `NOT_GRANTED`로 정상 응답한다.
  - 추천 후보가 부족하면 선택 조건을 완화하되 성별·나이 상호 조건, 지역, 차단, 정지·탈퇴 제외는 유지한다.
- 반복 호출: **멱등.** 재시도해도 운세가 바뀌거나 새로고침권이 중복 지급되지 않는다.

### GET `/daily` 🔜

운세·새로고침권 상태만 가볍게 조회한다. 지급 시도는 하지 않는다.

성공 `200`: `POST /daily/open`의 응답에서 `cards`와 `firstOpen`을 뺀 모양.

- 오류: `UNAUTHORIZED` 401, `RESOURCE_NOT_FOUND` 404(아직 `/daily/open`을 호출하지 않아 당일 운세가 없음)
- 특별 규칙: 읽기 전용이다. 이 API로는 새로고침권이 지급되지 않는다.
- 반복 호출: 멱등.

### GET `/recommendations/today` 🔜

당일 추천 카드 목록. 새로고침을 썼다면 새로고침된 묶음을 반환한다.

쿼리 없음. 카드가 최대 7장이므로 페이지네이션하지 않는다.

성공 `200`:

```json
{
  "success": true,
  "data": {
    "serviceDate": "2026-10-27",
    "sourceType": "REFRESH",
    "cards": [],
    "heartedUserIds": ["1042"],
    "requestedUserIds": []
  },
  "error": null
}
```

- `sourceType`: `INITIAL`(기본 묶음) `REFRESH`(새로고침 묶음)
- `heartedUserIds`, `requestedUserIds`: 이미 하트·채팅 요청을 보낸 상대. 화면이 버튼 상태를 그리는 데 쓴다.
- 오류: `UNAUTHORIZED` 401, `PROFILE_INCOMPLETE` 409, `RESOURCE_NOT_FOUND` 404(당일 운세 미공개)
- 특별 규칙: 차단·정지·탈퇴·추천 제외 상대는 사전 계산된 목록에서도 응답 시점에 다시 걸러낸다. 카드 생성 후 상태가 바뀐 경우를 반영하기 위함이며, 이때 카드 수는 `cardCount`보다 적을 수 있다.
- 반복 호출: 멱등.

### POST `/recommendations/refresh` 🔜

새로고침권을 사용해 새 카드 묶음을 받는다.

본문 없음. 성공 `200`:

```json
{
  "success": true,
  "data": {
    "serviceDate": "2026-10-27",
    "sourceType": "REFRESH",
    "cards": [],
    "refreshTicket": { "status": "USED", "usedAt": "2026-10-27T01:12:00Z" }
  },
  "error": null
}
```

- 오류: `UNAUTHORIZED` 401, `PROFILE_INCOMPLETE` 409, `REFRESH_TOKEN_NOT_FOUND` 404, `REFRESH_TOKEN_EXPIRED` 409, `REFRESH_TOKEN_ALREADY_USED` 409, `TOO_MANY_REQUESTS` 429
- 특별 규칙:
  - 기본 묶음에 이미 나왔던 상대는 제외한 새 카드를 반환한다.
  - 네트워크 재시도로 같은 요청이 두 번 도착해도 **한 번만 사용 처리**한다. 두 번째 호출은 이미 생성된 새로고침 묶음을 그대로 반환하며 새 묶음을 또 만들지 않는다.
  - 새로고침권은 다음 날 오전 8시(KST)에 만료된다.
- 반복 호출: 멱등. 위 규칙에 따라 결과가 같다.

### GET `/cards/{targetUserId}` 🔜

추천 카드 상세. 공개 정보와 추천 이유만 반환한다.

성공 `200`:

```json
{
  "success": true,
  "data": {
    "card": {},
    "hearted": false,
    "chatRequestStatus": "NONE"
  },
  "error": null
}
```

- `card`: `PublicCard`
- `chatRequestStatus`: `NONE` `PENDING` `ACCEPTED` `REJECTED` `IGNORED`
- 오류: `UNAUTHORIZED` 401, `RECOMMENDATION_NOT_FOUND` 404(오늘 나에게 노출된 카드가 아님), `TARGET_BLOCKED` 403, `BLOCKED_BY_TARGET` 403, `TARGET_UNAVAILABLE` 403
- 특별 규칙: **오늘 나에게 노출된 카드이거나 받은 하트의 발신자**일 때만 조회할 수 있다. 임의의 사용자 ID를 넣어 프로필을 수집하는 것을 막는다. 상세 프로필·원본 사진은 포함하지 않는다.
- 반복 호출: 멱등.

## 6. 하트

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| POST | `/cards/{targetUserId}/hearts` | 로그인 | 🔜 |
| DELETE | `/cards/{targetUserId}/hearts` | 로그인 | 🔜 |
| GET | `/hearts/received` | 로그인 | 🔜 |

### POST `/cards/{targetUserId}/hearts` 🔜

본문 없음. 성공 `201`:

```json
{ "success": true, "data": { "targetUserId": "1042", "hearted": true, "sentAt": "2026-10-27T01:20:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `SELF_ACTION_NOT_ALLOWED` 400, `RECOMMENDATION_NOT_FOUND` 404, `TARGET_BLOCKED` 403, `BLOCKED_BY_TARGET` 403, `TARGET_UNAVAILABLE` 403, `HEART_ALREADY_SENT` 409, `TOO_MANY_REQUESTS` 429
- 특별 규칙:
  - 하트는 채팅방을 만들지 않는다. 호감 표시만 한다.
  - 오늘 나에게 노출된 카드, 또는 받은 하트의 발신자에게만 보낼 수 있다.
  - 같은 상대에게 중복 하트는 허용하지 않는다.
  - 받는 사람에게 발신자 정보는 `PublicCard` 형태로만 보인다.
- 반복 호출: 멱등. 두 번째 호출은 `HEART_ALREADY_SENT`이며 하트가 두 개 생기지 않는다.

### DELETE `/cards/{targetUserId}/hearts` 🔜

하트 취소. 성공 `200`:

```json
{ "success": true, "data": { "targetUserId": "1042", "hearted": false }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `HEART_NOT_FOUND` 404
- 특별 규칙: 취소한 하트는 인기 배지 집계에서 제외된다. 다만 집계 왜곡을 막기 위해 행을 지우지 않고 취소 시각을 남긴다.
- 반복 호출: 멱등.

### GET `/hearts/received` 🔜

받은 하트 목록. 목록 응답 형식을 따른다.

쿼리: `?cursor=&limit=` (최신순)

성공 `200`:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "heartId": "5521",
        "sender": {},
        "receivedAt": "2026-10-27T01:20:00Z",
        "chatRequestStatus": "NONE"
      }
    ],
    "nextCursor": null,
    "hasMore": false
  },
  "error": null
}
```

- `sender`: `PublicCard`. 원본 사진·상세 프로필은 없다.
- `chatRequestStatus`: 내가 이 발신자에게 보낸 채팅 요청의 상태. `NONE` `PENDING` `ACCEPTED` `REJECTED` `IGNORED`
- 오류: `UNAUTHORIZED` 401
- 특별 규칙: 차단·정지·탈퇴한 발신자의 하트는 목록에서 **제외**된다. 취소된 하트도 제외된다.
- 반복 호출: 멱등.

## 7. 채팅 요청

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| POST | `/chat-requests` | 로그인 | 🔜 |
| GET | `/chat-requests/received` | 로그인 | 🔜 |
| GET | `/chat-requests/sent` | 로그인 | 🔜 |
| POST | `/chat-requests/{requestId}/accept` | 로그인(수신자) | 🔜 |
| POST | `/chat-requests/{requestId}/reject` | 로그인(수신자) | 🔜 |
| POST | `/chat-requests/{requestId}/ignore` | 로그인(수신자) | 🔜 |

### POST `/chat-requests` 🔜

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `targetUserId` | string | 필수 | 숫자 문자열 |
| `message` | string | 필수 | 1~200자 |

```json
{ "targetUserId": "1042", "message": "전시 좋아하신다니 반가워요. 이야기 나눠 볼까요?" }
```

성공 `201`:

```json
{ "success": true, "data": { "requestId": "8810", "targetUserId": "1042", "status": "PENDING", "createdAt": "2026-10-27T01:25:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `VALIDATION_ERROR` 400, `SELF_ACTION_NOT_ALLOWED` 400, `CHAT_REQUEST_NOT_ALLOWED` 403, `TARGET_BLOCKED` 403, `BLOCKED_BY_TARGET` 403, `TARGET_UNAVAILABLE` 403, `CHAT_RESTRICTED` 403, `CHAT_REQUEST_ALREADY_PENDING` 409, `TOO_MANY_REQUESTS` 429
- 특별 규칙:
  - **오늘(기본 또는 새로고침) 나에게 노출된 카드의 상대, 또는 받은 하트의 발신자**에게만 보낼 수 있다. 그 외에는 `CHAT_REQUEST_NOT_ALLOWED`.
  - 같은 상대에게 `PENDING` 상태의 요청이 이미 있으면 중복 생성하지 않는다.
  - 거절·무시된 뒤 다시 보낼 수 있는지는 팀 합의 사항이다. 현재 계약은 **같은 서비스 날짜에는 재요청 불가**로 정한다.
- 반복 호출: 멱등. 두 번째 호출은 `CHAT_REQUEST_ALREADY_PENDING`.

### GET `/chat-requests/received` 🔜

쿼리: `?status=PENDING&cursor=&limit=` (`status` 생략 시 전체)

성공 `200`:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "requestId": "8810",
        "sender": {},
        "message": "전시 좋아하신다니 반가워요.",
        "status": "PENDING",
        "createdAt": "2026-10-27T01:25:00Z",
        "respondedAt": null
      }
    ],
    "nextCursor": null,
    "hasMore": false
  },
  "error": null
}
```

- `sender`: `PublicCard`. 수락 전이므로 원본 사진·상세 프로필은 **없다.**
- `status`: `PENDING` `ACCEPTED` `REJECTED` `IGNORED`
- 오류: `UNAUTHORIZED` 401
- 반복 호출: 멱등.

### GET `/chat-requests/sent` 🔜

`received`와 같은 모양이고 `sender` 대신 `target`(`PublicCard`)을 담는다.

- 특별 규칙: 상대가 무시(`IGNORED`)한 경우에도 발신자에게는 `PENDING`으로 보인다. 무시 사실을 상대에게 알리지 않기 위함이다. 이 처리는 프론트·보안 담당과 합의가 필요하다.
- 반복 호출: 멱등.

### POST `/chat-requests/{requestId}/accept` 🔜

수락하고 채팅방을 만든다. 본문 없음.

성공 `201`:

```json
{ "success": true, "data": { "requestId": "8810", "status": "ACCEPTED", "roomId": "3301", "respondedAt": "2026-10-27T01:40:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `CHAT_REQUEST_NOT_FOUND` 404, `FORBIDDEN` 403(수신자가 아님), `CHAT_REQUEST_ALREADY_RESOLVED` 409, `TARGET_UNAVAILABLE` 403, `BLOCKED_BY_TARGET` 403, `CHAT_RESTRICTED` 403
- 특별 규칙:
  - 수락 요청당 채팅방을 **하나만** 만든다. 참여자는 2명이다.
  - 수락 시점에 **양쪽 모두에게 동시에** 실제 사진·상세 프로필 공개 권한이 생긴다. 공개 데이터 자체는 이 응답에 담지 않고 채팅방 조회에서 받는다.
  - 수락 처리와 채팅방 생성은 한 트랜잭션으로 처리한다.
- 반복 호출: 멱등. 재시도 시 이미 만들어진 `roomId`를 그대로 반환하거나 `CHAT_REQUEST_ALREADY_RESOLVED`를 반환한다. 방이 두 개 생기지 않는다.

### POST `/chat-requests/{requestId}/reject` 🔜

성공 `200`:

```json
{ "success": true, "data": { "requestId": "8810", "status": "REJECTED", "respondedAt": "2026-10-27T01:41:00Z" }, "error": null }
```

- 오류: `accept`와 같은 목록에서 `TARGET_UNAVAILABLE`, `CHAT_RESTRICTED` 제외
- 특별 규칙: 채팅방을 만들지 않고 원본 사진 URL도 제공하지 않는다.
- 반복 호출: 멱등.

### POST `/chat-requests/{requestId}/ignore` 🔜

**신규 추가.** 기존 명세에는 `accept`·`reject`만 있었으나 UX 시나리오(U3)와 화면 정의에 "무시"가 있어 경로를 추가했다.

성공 `200`:

```json
{ "success": true, "data": { "requestId": "8810", "status": "IGNORED", "respondedAt": "2026-10-27T01:41:00Z" }, "error": null }
```

- 특별 규칙: 발신자에게는 계속 `PENDING`으로 보인다. 수신자 목록에서는 숨긴다.
- 반복 호출: 멱등.

## 8. 채팅방·메시지

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| GET | `/chat-rooms` | 로그인(참여자) | 🔜 |
| GET | `/chat-rooms/{roomId}` | 로그인(참여자) | 🔜 |
| GET | `/chat-rooms/{roomId}/messages` | 로그인(참여자) | 🔜 |
| POST | `/chat-rooms/{roomId}/messages` | 로그인(참여자) | 🔜 |

### GET `/chat-rooms` 🔜

내 채팅방 목록(메시지함). 목록 응답 형식.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "roomId": "3301",
        "partner": {},
        "lastMessage": { "preview": "내일 저녁 어때요?", "sentAt": "2026-10-27T02:10:00Z", "senderId": "1042" },
        "unreadCount": 2,
        "createdAt": "2026-10-27T01:40:00Z"
      }
    ],
    "nextCursor": null,
    "hasMore": false
  },
  "error": null
}
```

- `partner`: **`PublicCard`를 쓴다.** 목록에서는 원본 사진을 주지 않는다. 실제 사진은 방 상세에서만 제공한다.
- 오류: `UNAUTHORIZED` 401
- 특별 규칙: 상대가 정지·탈퇴했거나 차단 관계가 되면 목록에서 제외한다. 과거 메시지 열람이 필요하면 `GET /chat-rooms/{roomId}`로 직접 접근한다.
- 반복 호출: 멱등.

### GET `/chat-rooms/{roomId}` 🔜

**이 API만 `RevealedProfile`을 반환한다.**

성공 `200`:

```json
{
  "success": true,
  "data": {
    "roomId": "3301",
    "createdAt": "2026-10-27T01:40:00Z",
    "partner": {},
    "canSendMessage": true,
    "blockedByMe": false,
    "blockedByPartner": false
  },
  "error": null
}
```

- `partner`: `RevealedProfile`. 원본 사진 임시 URL(60초)이 포함된다.
- 오류: `UNAUTHORIZED` 401, `CHAT_ROOM_NOT_FOUND` 404, `NOT_ROOM_MEMBER` 403
- 특별 규칙:
  - **수락된 방의 두 참여자만** 호출할 수 있다. 제3자와 관리자는 `NOT_ROOM_MEMBER` 또는 `FORBIDDEN`으로 거부한다.
  - 차단·정지·탈퇴가 발생하면 `partner.originalImages`를 빈 배열로 반환하고 `canSendMessage`를 `false`로 내린다. 상세 프로필 텍스트 노출 범위는 보안 담당과 합의가 필요하다.
  - 응답에 `Cache-Control: no-store`를 붙인다.
- 반복 호출: 멱등. 호출마다 새 임시 URL이 발급된다.

### GET `/chat-rooms/{roomId}/messages` 🔜

쿼리: `?cursor=&limit=` (오래된 순으로 거슬러 올라가는 커서)

```json
{
  "success": true,
  "data": {
    "items": [
      { "messageId": "77012", "senderId": "1042", "body": "내일 저녁 어때요?", "sentAt": "2026-10-27T02:10:00Z" }
    ],
    "nextCursor": "eyJpZCI6Ijc3MDEyIn0",
    "hasMore": true
  },
  "error": null
}
```

- 오류: `UNAUTHORIZED` 401, `CHAT_ROOM_NOT_FOUND` 404, `NOT_ROOM_MEMBER` 403
- 특별 규칙: 차단 후에도 기존 참여자는 **과거 메시지 조회만** 가능하다. 조회 시 내 읽음 위치를 갱신해 `unreadCount`에 반영한다.
- 반복 호출: 멱등.

### POST `/chat-rooms/{roomId}/messages` 🔜

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `body` | string | 필수 | 1~1000자 |
| `clientMessageId` | string | 선택 | 최대 64자. 재시도 중복 방지용 |

성공 `201`:

```json
{ "success": true, "data": { "messageId": "77013", "senderId": "7", "body": "좋아요!", "sentAt": "2026-10-27T02:12:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `VALIDATION_ERROR` 400, `CHAT_ROOM_NOT_FOUND` 404, `NOT_ROOM_MEMBER` 403, `TARGET_BLOCKED` 403, `BLOCKED_BY_TARGET` 403, `CHAT_RESTRICTED` 403, `TARGET_UNAVAILABLE` 403, `TOO_MANY_REQUESTS` 429
- 특별 규칙: 메시지 본문은 로그에 남기지 않는다. 차단·정지·탈퇴 상태에서는 전송이 거부된다.
- 반복 호출: `clientMessageId`를 보내면 멱등(같은 값의 두 번째 요청은 기존 메시지를 반환). 생략하면 비멱등.

## 9. 차단·신고

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| GET | `/me/blocks` | 로그인 | 🔜 |
| POST | `/me/blocks` | 로그인 | 🔜 |
| DELETE | `/me/blocks/{targetUserId}` | 로그인 | 🔜 |
| POST | `/reports` | 로그인 | 🔜 |

### GET `/me/blocks` 🔜

```json
{
  "success": true,
  "data": {
    "items": [ { "targetUserId": "1042", "displayName": "서윤", "blockedAt": "2026-10-27T03:00:00Z" } ],
    "nextCursor": null,
    "hasMore": false
  },
  "error": null
}
```

- 특별 규칙: 차단 목록에는 공개 이미지도 포함하지 않는다. 이름과 차단 시각만 제공한다. 상대가 탈퇴해도 항목은 유지되며 `displayName`은 `탈퇴한 사용자`로 대체한다.
- 반복 호출: 멱등.

### POST `/me/blocks` 🔜

| 필드 | 타입 | 필수 |
|---|---|---|
| `targetUserId` | string | 필수 |

성공 `201`:

```json
{ "success": true, "data": { "targetUserId": "1042", "blocked": true, "blockedAt": "2026-10-27T03:00:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `VALIDATION_ERROR` 400, `SELF_ACTION_NOT_ALLOWED` 400, `RESOURCE_NOT_FOUND` 404
- 특별 규칙: 차단하면 **양방향으로** 신규 요청·메시지 전송·상대 실제 사진 신규 URL 발급이 즉시 중단된다. 이미 발급된 임시 URL은 만료(최대 60초)까지 유효하며 회수할 수 없다. 기존 메시지는 양쪽 모두 조회만 가능하다.
- 반복 호출: 멱등. 이미 차단된 상대면 기존 정보를 그대로 반환한다.

### DELETE `/me/blocks/{targetUserId}` 🔜

성공 `200`:

```json
{ "success": true, "data": { "targetUserId": "1042", "blocked": false }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `BLOCK_NOT_FOUND` 404
- 특별 규칙: 차단 해제가 과거 추천 카드를 되살리지는 않는다. 다음 서비스 날짜 추천부터 후보에 다시 포함된다.
- 반복 호출: 멱등.

### POST `/reports` 🔜

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `targetType` | enum | 필수 | `USER` `MESSAGE` |
| `targetId` | string | 필수 | 사용자 ID 또는 메시지 ID |
| `reasonCode` | enum | 필수 | `SPAM` `ABUSE` `SEXUAL` `FAKE_PROFILE` `UNDERAGE` `OTHER` |
| `detail` | string 또는 null | 선택 | 최대 500자 |

성공 `201`:

```json
{ "success": true, "data": { "reportId": "4410", "status": "PENDING", "createdAt": "2026-10-27T03:05:00Z" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `VALIDATION_ERROR` 400, `SELF_ACTION_NOT_ALLOWED` 400, `RESOURCE_NOT_FOUND` 404, `REPORT_ALREADY_EXISTS` 409, `TOO_MANY_REQUESTS` 429
- 특별 규칙:
  - 메시지를 신고하려면 내가 그 방의 참여자여야 한다.
  - 신고 결과·처리 상태는 신고자에게 알리지 않는다. 처리 내역은 관리자 화면에서만 본다.
  - 같은 대상·같은 사유로 처리 대기 중인 신고가 있으면 중복 생성하지 않는다.
- 반복 호출: 멱등.

## 10. 관리자 API ⏳

**전체 구현 상태 ⏳ — 담당·시점 미정.** 팀장의 Phase 2 백엔드 지시 범위에는 없고, 프론트엔드가 Phase 2에 관리자 화면을 만들기 때문에 계약만 먼저 확정한다. 누가 언제 구현할지 팀 합의가 필요하다.

공통 조건(`docs/SECURITY_OPERATIONS.md` 2절 기준):

1. 모든 `/admin` 경로는 Bearer 토큰 검증 후 **요청 시점의 DB 역할이 `ADMIN`이고 계정이 활성인지** 다시 확인한다. 토큰의 역할 값만 믿지 않는다.
2. 일반 사용자·권한 회수·정지·탈퇴는 `403 FORBIDDEN`으로 거부한다.
3. 관리자 전용 도메인의 허용 IP만 수신한다. 사용자가 보낸 `X-Forwarded-For`는 신뢰하지 않는다.
4. 제재·신고 처리·설정 변경은 관리자 ID, 요청 ID, 대상, 변경 전후 값, 결과, UTC 시각을 감사 로그에 남긴다.
5. 관리자에게 원본 사진 전체 조회 권한을 자동 부여하지 않는다. 검수 권한은 별도 설계 사항이다.
6. 모든 `/admin` 경로에 속도 제한을 적용한다.

| Method | Path | 설명 | 구현 상태 |
|---|---|---|---|
| GET | `/admin/dashboard` | 운영 지표 | ⏳ |
| GET | `/admin/users` | 사용자 목록 | ⏳ |
| PATCH | `/admin/users/{userId}/sanction` | 제재 변경 | ⏳ |
| GET | `/admin/reports` | 신고 목록 | ⏳ |
| PATCH | `/admin/reports/{reportId}` | 신고 처리 | ⏳ |
| GET | `/admin/settings` | 설정 조회 | ⏳ |
| PUT | `/admin/settings/badge` | 배지 기준 변경 | ⏳ |
| PUT | `/admin/settings/daily-refresh` | 다음 일자 선착순 N 변경 | ⏳ |
| GET | `/admin/statistics/daily` | 일별 통계 | ⏳ |

### GET `/admin/dashboard` ⏳

쿼리: `?serviceDate=2026-10-27` (생략 시 오늘)

```json
{
  "success": true,
  "data": {
    "serviceDate": "2026-10-27",
    "signups": 42,
    "fortuneOpens": 310,
    "cardViews": 1180,
    "hearts": 260,
    "chatRequests": 95,
    "chatRoomsCreated": 38,
    "reportsPending": 4,
    "refreshInventory": { "total": 100, "remaining": 0, "grantedCount": 100 }
  },
  "error": null
}
```

- 오류: `UNAUTHORIZED` 401, `FORBIDDEN` 403
- 특별 규칙: 집계 수치만 반환하며 개인정보는 포함하지 않는다.
- 반복 호출: 멱등.

### GET `/admin/users` ⏳

쿼리: `?status=ACTIVE&q=&cursor=&limit=`

```json
{
  "success": true,
  "data": {
    "items": [
      { "userId": "1042", "email": "user01@example.com", "role": "USER", "status": "ACTIVE", "displayName": "서윤", "createdAt": "2026-10-20T00:00:00Z", "lastActiveAt": "2026-10-27T01:00:00Z", "reportCount": 1 }
    ],
    "nextCursor": null,
    "hasMore": false
  },
  "error": null
}
```

- 특별 규칙: 관리 목적에 필요한 최소 필드만 반환한다. 비밀번호 해시, 원본 사진 URL·object key, 채팅 본문은 포함하지 않는다.
- 반복 호출: 멱등.

### PATCH `/admin/users/{userId}/sanction` ⏳

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `status` | enum | 필수 | `ACTIVE` `RECOMMENDATION_BLOCKED` `CHAT_RESTRICTED` `SUSPENDED` |
| `reason` | string | 필수 | 1~200자 |

성공 `200`:

```json
{ "success": true, "data": { "userId": "1042", "previousStatus": "ACTIVE", "status": "SUSPENDED", "changedAt": "2026-10-27T03:30:00Z", "auditLogId": "9001" }, "error": null }
```

- 오류: `UNAUTHORIZED` 401, `FORBIDDEN` 403, `VALIDATION_ERROR` 400, `RESOURCE_NOT_FOUND` 404
- 특별 규칙: `WITHDRAWN`으로는 바꿀 수 없다(탈퇴는 본인만). 상태 변경과 감사 로그 기록은 한 트랜잭션으로 처리한다.
- 반복 호출: 멱등. 같은 값으로 다시 호출하면 상태는 그대로이고 감사 로그도 추가로 남기지 않는다.

### GET `/admin/reports` ⏳

쿼리: `?status=PENDING&cursor=&limit=`

```json
{
  "success": true,
  "data": {
    "items": [
      { "reportId": "4410", "targetType": "USER", "targetId": "1042", "reasonCode": "ABUSE", "detail": "욕설", "status": "PENDING", "reporterUserId": "7", "createdAt": "2026-10-27T03:05:00Z", "handledAt": null, "resultNote": null }
    ],
    "nextCursor": null,
    "hasMore": false
  },
  "error": null
}
```

- `status`: `PENDING` `REVIEWING` `RESOLVED` `DISMISSED`
- 반복 호출: 멱등.

### PATCH `/admin/reports/{reportId}` ⏳

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `status` | enum | 필수 | `REVIEWING` `RESOLVED` `DISMISSED` |
| `resultNote` | string | 필수 | 1~500자 |

성공 `200`: 갱신된 신고 객체 + `auditLogId`.

- 특별 규칙: 처리 결과는 신고자에게 통보하지 않는다. 제재가 필요하면 제재 API를 별도로 호출한다.
- 반복 호출: 멱등.

### GET `/admin/settings` ⏳

```json
{
  "success": true,
  "data": {
    "badge": { "popularMinUniqueHearts": 10, "popularMinUniqueChatRequests": 5, "windowDays": 30 },
    "dailyRefresh": { "currentServiceDate": "2026-10-27", "currentTotal": 100, "currentRemaining": 0, "nextServiceDate": "2026-10-28", "nextTotal": 100 }
  },
  "error": null
}
```

- 반복 호출: 멱등.

### PUT `/admin/settings/badge` ⏳

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `popularMinUniqueHearts` | number | 필수 | 정수 1~1000 |
| `popularMinUniqueChatRequests` | number | 필수 | 정수 1~1000 |
| `windowDays` | number | 선택 | 정수 7~90, 기본 30 |

성공 `200`: 갱신된 `badge` 객체 + `auditLogId`.

- 오류: `SETTING_NOT_ALLOWED` 400(허용 범위 초과)
- 특별 규칙: 배지는 최근 `windowDays`일의 **서로 다른 발신자** 기준으로 집계한다. 수치는 사용자에게 노출하지 않는다. 차단·제재·신고 검토 중 계정의 반응은 집계에서 제외한다.
- 반복 호출: 멱등.

### PUT `/admin/settings/daily-refresh` ⏳

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `nextTotal` | number | 필수 | 정수 0~10000 |

성공 `200`:

```json
{ "success": true, "data": { "nextServiceDate": "2026-10-28", "nextTotal": 150, "auditLogId": "9003" }, "error": null }
```

- 오류: `SETTING_NOT_ALLOWED` 400
- 특별 규칙: **다음 서비스 날짜부터** 적용한다. 당일 재고를 다시 채우지 않는다. 적용 일자를 서버가 계산하며 클라이언트가 지정할 수 없다.
- 반복 호출: 멱등.

### GET `/admin/statistics/daily` ⏳

쿼리: `?from=2026-10-20&to=2026-10-27` (최대 90일)

```json
{
  "success": true,
  "data": {
    "items": [
      { "serviceDate": "2026-10-27", "signups": 42, "fortuneOpens": 310, "hearts": 260, "chatRequests": 95, "chatRoomsCreated": 38, "reports": 4, "refreshGranted": 100 }
    ]
  },
  "error": null
}
```

- 오류: `VALIDATION_ERROR` 400(기간 초과·역순)
- 반복 호출: 멱등.

## 11. 상태 확인

| Method | Path | 권한 | 구현 상태 |
|---|---|---|---|
| GET | `/health` | 공개 | ✅ |

`/api/v1` 접두사가 **없는** 경로다. 인프라 헬스체크용이다.

```json
{ "success": true, "data": { "status": "ok", "database": "connected" }, "error": null }
```

- 오류: DB 연결 실패 시 `INTERNAL_SERVER_ERROR` 500
- 특별 규칙: 버전·호스트명 등 내부 정보를 노출하지 않는다.
- 반복 호출: 멱등.

## 기존 명세와 달라진 부분

| 항목 | 이전 | 변경 | 이유 |
|---|---|---|---|
| `POST /chat-requests/{requestId}/ignore` | 없음 | 추가 | UX 시나리오 U3와 화면 정의에 "무시"가 있으나 경로가 없었다. |
| `/dev/test-accounts` 3개 | 없음 | 추가 | Phase 1에서 빠진 테스트 계정 선택 기능. 운영 환경에서는 비활성. |
| `GET /me/images`, `DELETE /me/images/{imageId}` | 없음 | 추가 | 마이페이지 사진 재업로드·삭제 화면에 필요. |
| `DELETE /me` | 없음 | 추가 | 마이페이지 탈퇴 기능에 필요. |
| `GET/POST/DELETE /me/blocks[/{targetUserId}]` | 한 줄로 묶여 있었음 | 메서드별로 분리 기재 | DELETE에 경로 변수가 필요해 모양이 다르다. 경로 자체는 그대로다. |
| `GET /admin/reports[/{reportId}]` | 한 줄로 묶여 있었음 | `GET /admin/reports`와 `PATCH /admin/reports/{reportId}`로 분리 | 목록 조회와 개별 처리의 메서드·경로가 다르다. 경로 자체는 그대로다. |
| 목록 응답 | 형식 미정 | `items` + `nextCursor` + `hasMore` 커서 방식으로 통일 | 프론트가 모든 목록 화면에 같은 처리 코드를 쓸 수 있다. |
| 숫자 ID | 미정 | 응답에서 문자열로 전달 | DB가 `BIGINT`여서 JavaScript 정수 범위를 넘을 수 있다. |
| 오류 코드 표 | 7개 | 공통 8개 + 기능별 25개로 확장 | 기존 7개는 코드·HTTP 상태를 그대로 유지했다. |

**경로를 바꾼 것은 없다.** 기존 명세에 있던 경로는 모두 그대로 두고 추가·분리만 했다.
