# KKAGUNG 프론트엔드 — Phase 1

정적 SPA입니다. 회원가입·로그인·프로필·선호 조건은 백엔드 `/api/v1`과 연결되고, 운세·추천은 Phase 2 API가 아직 없어 목업 카드로 표시합니다.

## 실행

전체 통합 실행은 루트에서 다음을 사용합니다.

```bash
docker compose -f infra/docker-compose.yml up --build
```

- 프론트: `http://localhost:5173`
- API: `http://localhost:8080`
- MySQL: `localhost:3306`

프론트만 실행할 때는 Node.js 18 이상에서 다음을 실행합니다.

```bash
npm run dev
```

`API_BASE_URL`은 서버가 `/config.js`로 주입합니다. 기본값은 `http://localhost:8080`입니다.

## Phase 1 API 연결

| 목적 | 메서드/경로 |
| --- | --- |
| 가입 | `POST /api/v1/auth/register` |
| 로그인 | `POST /api/v1/auth/login` |
| 내 정보 조회 | `GET /api/v1/me` |
| 프로필 저장 | `PUT /api/v1/me/profile` |
| 선호 조건 저장 | `PUT /api/v1/me/preferences` |

브라우저는 Access Token을 현재 세션 동안만 `sessionStorage`에 보관합니다. 원본 사진·API 키·비밀값은 프론트에 저장하지 않습니다.
