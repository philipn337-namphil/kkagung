# KKAGUNG 프론트엔드 — Phase 1

로그인, 회원가입, 프로필 등록, 홈 추천 화면을 포함한 정적 SPA 뼈대입니다. 현재는 백엔드가 준비되기 전까지 동작을 확인할 수 있는 목업 API를 사용합니다.

## 실행

Node.js 18 이상에서 아래를 실행합니다.

```bash
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다.

## 화면 및 경로

| 화면 | 주소 | 비고 |
| --- | --- | --- |
| 랜딩 | `#/` | 서비스 소개 |
| 로그인 | `#/login` | 목업 로그인 |
| 회원가입 | `#/signup` | 완료 후 프로필 등록 이동 |
| 프로필 등록/수정 | `#/profile` | 관심사 복수 선택 가능 |
| 홈 | `#/home` | 목업 추천 카드 |

## 백엔드 연동 계약(초안)

프론트의 `app.js` 상단 `api` 객체가 교체 지점입니다. `API_BASE_URL`은 실행 시 서버가 `/config.js`로 주입합니다. PowerShell에서는 다음처럼 설정할 수 있습니다.

```powershell
$env:API_BASE_URL = 'http://localhost:8080'
npm run dev
```

| 목적 | 메서드/경로 | 요청 핵심 필드 | 응답 핵심 필드 |
| --- | --- | --- | --- |
| 가입 | `POST /auth/signup` | `name,email,password` | `id,name,email` |
| 로그인 | `POST /auth/login` | `email,password` | `accessToken,user` |
| 내 프로필 저장 | `PUT /profiles/me` | `nickname,gender,birthYear,introduction,interests[]` | 저장된 프로필 |
| 추천 조회 | `GET /recommendations` | - | `name,age,district,bio,tags[]` 배열 |

인증 토큰은 응답 본문에서 사용하되, 원본 사진 URL·비밀값·JWT를 소스 코드에 넣지 않습니다. 사진은 백엔드가 공개용 리사이즈 URL만 반환해야 합니다.

## Phase 1 종료 보고

```text
[Phase 1 완료]
- 브랜치: develop 병합 전, frontend/phase1-skeleton 권장
- 구현/작성한 것: 공통 헤더·푸터, 해시 라우팅, 로그인·가입·프로필·홈 화면, 목업 API, API 계약 초안, 환경변수 예시
- 실행 방법: Node.js 18+ 설치 후 npm run dev → http://localhost:5173
- API 또는 DB 변경: 프론트에서 제안한 인증/프로필/추천 API 계약은 위 표 참조. DB 변경 없음.
- 다른 담당자가 알아야 할 사항: app.js의 api 객체를 실제 fetch 호출로 교체하고, API_BASE_URL을 배포 환경에서 주입해야 함. 사진은 공개용 URL만 노출.
- 미완료·막힌 점: GitHub 저장소가 인증 필요로 확인되어 기존 프레임워크/코드와의 직접 통합은 하지 못함. 백엔드 실제 명세 확정 후 필드명 및 인증 저장 방식을 맞춰야 함.
```
