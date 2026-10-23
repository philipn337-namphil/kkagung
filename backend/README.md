# 까궁 API — Phase 1

## 구현됨

- MySQL Prisma 스키마·초기 마이그레이션
- 사용자·프로필·선호 조건 테이블
- 회원가입·로그인 JWT 인증
- 내 정보, 프로필, 선호 조건 API
- DB 연결 상태 확인 `/health`
- 테스트용 관리자·일반 사용자 시드

## API 빠른 확인

```bash
POST /api/v1/auth/register
{ "email": "me@example.com", "password": "password123!", "adultVerified": true }
```

로그인 뒤 받은 토큰을 `Authorization: Bearer <token>`으로 전달한다.

```bash
PUT /api/v1/me/profile
{
  "displayName": "필량", "birthDate": "2000-01-01", "gender": "MALE",
  "regionCode": "SEOUL_DONGDAEMUN", "heightCm": 175,
  "jobCategory": "STUDENT", "mbti": "INTJ"
}
```

Phase 2에서 운세·추천·하트·채팅·사진 업로드 API를 추가한다.
