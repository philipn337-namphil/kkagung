# 실제 NCP·운영 복구 검증 인계

2026-10-27 사용자 확인: **테스트 서버·버킷·DB·NAS·백업본이 아직 없음.** 현재 실행 환경에도 NCP/Object Storage/DB 접속 설정이 없다. 실제 클라우드 검증은 미실행이며, 로컬 545개 권한 검사나 MySQL 복원을 이 항목의 통과로 집계하지 않는다.

## 자원 준비 순서

보안·운영은 검증과 증빙, 인프라 담당은 테스트 자원·네트워크·백업 준비, 백엔드 담당은 배포·가상 데이터·복원 정합성 확인을 맡는다. 새 자원 생성 전 계정/리전, 사용 기간, 예산 상한, 정리 담당자를 정한다. 이 문서는 과금 자원을 생성하거나 접근 권한을 변경한 결과가 아니다.

| 단계 | 인프라 담당이 준비할 것 | 보안·운영의 완료 증빙 |
|---|---|---|
| 1. 실제 스토리지 | 같은 테스트 환경의 원본/공개 객체용 버킷 2개, HTTPS endpoint, 테스트 범위의 키 | 익명 원본 읽기·목록 거부, 공개 가상 객체 읽기, 정상/변조/만료 서명 결과와 정확한 시험 객체 정리 |
| 2. 네트워크 | VPC·서브넷·ACG/NACL, HTTPS LB, Private API 서버, 관리자 허용 출발지와 비허용 출발지 | 외부→LB 성공, 외부→앱/DB 직접 접근 거부, LB→앱 및 앱→DB 허용, 관리자 CIDR와 XFF 위조 거부 |
| 3. DB 복구 | Cloud DB for MySQL 테스트 서비스, 가상 데이터 백업, 별도 복원 서비스 생성 권한·예산 | 클라우드 백업/복원 기록, 행·관계·제약·role/status·토큰 폐기 상태, 서비스 동작과 소요 시간 |
| 4. 사진/NAS 복구 | 가상 이미지 백업본/버전, 테스트 NAS와 스냅샷, 승인 서버 마운트 | 별도 시험 대상에 복구한 파일 해시·DB 참조, 비공개 유지, 삭제 이력 반영, NAS 권한·앱 동작 |
| 5. 운영 판정 | 승인 목표 RPO/RTO, 백업 주기·보관·알림·삭제 정책, 비용 종료 확인 | 실제 시각을 포함한 측정치, 목표 대비 판정, 잔여 자원·후속 담당자 |

단계 1만 준비되면 스토리지 검증부터 실행할 수 있다. 모든 자원이 한꺼번에 준비될 필요는 없다. 테스트 서버 한 대에서의 보안 확인은 기획서의 운영 서버 두 대·장애 복구/Auto Scaling 확인을 대신하지 않는다.

## 스토리지 인계 조건

- 기존 실행기는 `kkagung-test-*`, `kkagung-staging-*`, `kkagung-security-*` 중 서로 다른 버킷 두 개만 받는다. 리전 suffix 등은 인프라 담당이 실제 계정에서 정한다.
- 원본 객체와 원본 버킷 목록은 비공개다. 공개 이미지 버킷도 목록 공개를 필요 조건으로 삼지 않는다. **공개 가상 객체의 읽기만** 허용한다. NCP의 버킷 공개와 개별 파일 공개는 별개다.
- 실행 계정은 시험용 버킷의 고유 prefix에서 Put/Get/Delete에 필요한 권한만 갖는다. 실행기가 버킷/ACL/정책을 생성·수정하지는 않는다. 정책 설정·확인은 별도 담당자가 수행한다.
- 아래 설정은 실행 프로세스의 환경에 주입한다. 키를 채팅/문서/커밋에 넣지 않는다. `.env` 파일을 만들기만 해서는 이 Node 도구가 자동으로 읽지 않는다.

| 환경변수 | 필요한 내용 |
|---|---|
| OBJECT_STORAGE_ENDPOINT | 실제 테스트 리전의 HTTPS endpoint, 자격증명·쿼리 제외 |
| OBJECT_STORAGE_REGION | 테스트 버킷과 맞는 리전 |
| OBJECT_STORAGE_BUCKET_PRIVATE / OBJECT_STORAGE_BUCKET_PUBLIC | 위 이름 규칙을 만족하는 기존 버킷 두 개 |
| OBJECT_STORAGE_ACCESS_KEY / OBJECT_STORAGE_SECRET_KEY | 시험 범위 계정의 비밀값, 환경으로만 주입 |
| SECURITY_STORAGE_TEST_RESOURCES | 실제 시험 자원임을 확인한 뒤 true |

```powershell
# 네트워크 호출 없는 설정 확인
node infra/security/ncp-storage-check.mjs --plan
# 자원/환경 준비 후, 고유 prefix의 가상 텍스트 두 개만 생성·검사·정리
node infra/security/ncp-storage-check.mjs --run
```

결과: `evidence/ncp-storage-results.json`. 로컬 모형은 서명 만료를 실제 NCP처럼 강제하지 않으므로 기존 모형 결과를 복사해 채우지 않는다. 정리 실패가 있으면 완료로 판정하지 않고 잔여 시험 객체만 담당자가 확인한다.

## 네트워크·관리자 확인

설정 화면만 보는 검토와 실제 요청 검사를 구분한다. 인프라 담당은 LB/앱/DB 포트, 소스 ACG·CIDR, TRUST_PROXY와 ADMIN_ALLOWED_IP_CIDRS의 배포 값을 비밀 없는 형태로 제시한다. 보안 담당은 허용 운영 경로와 비허용 외부 경로에서 실제 요청을 수행한다. 앱/DB 포트를 0.0.0.0/0에 열어서 검증하지 않는다.

관리자 허용 IP에서 유효 ADMIN/ACTIVE는 성공해야 하며, 일반 사용자·정지 관리자·허용 밖 IP는 거부돼야 한다. 허용 밖 요청의 X-Forwarded-For를 허용 IP로 바꿔도 통과하면 안 된다. 로그에는 토큰·채팅·사진 URL을 남기지 않는다.

## 복구 실행 순서와 측정

1. 가상 사용자·메시지·차단·토큰 폐기 및 가상 사진/NAS 파일의 기준 해시·마지막 데이터 시각을 기록한다.
2. 실제 클라우드 백업/스냅샷 성공과 식별자·완료 시각을 확인한다. Cloud DB의 Stand Alone 구성은 PITR을 지원하지 않으므로 PITR 시험이 필요하면 지원 구성을 준비한다.
3. 원래 대상에 덮어쓰지 않고 별도 테스트 DB/복구 대상에서 시험한다. NAS는 시험 전용 볼륨·스냅샷으로만 복구한다. 운영 볼륨 전체를 롤백하지 않는다.
4. DB 건수·관계·키 제약·제재/탈퇴/권한·토큰 폐기 목록, 이미지 object_key/해시와 비공개, NAS 해시/접근을 대조한다. 삭제 이력에 있는 사진을 다시 노출하지 않는다.
5. 복원된 앱으로 로그인/관리자 권한/수락 사진/차단 메시지를 검사한다. 복원 직후 보안 상태가 과거로 돌아가면 격리 상태를 유지하고 재차단/세션 폐기 등 복구 조치가 끝날 때까지 서비스에 연결하지 않는다.
6. RTO는 복구 요청 접수부터 앱 검증 완료까지, RPO는 장애 기준 시각과 실제 복구된 마지막 데이터 시각의 차이로 측정한다. 파일 복사 시간만 RTO로 쓰지 않는다. 시각은 UTC와 타임존을 함께 기록한다.
7. 가상 시험에서 잰 시간은 테스트 환경 측정치다. 운영 데이터량·백업 경로·인력 대응이 다른 상태에서 운영 RPO/RTO 달성으로 판정하지 않는다. 운영 목표는 팀 승인값이 있어야 비교할 수 있다.
8. 알림 수신과 백업/임시 자원 보관·정리·비용을 확인한다. 실제 증빙은 [BACKUP_RESTORE_CHECKLIST.md](BACKUP_RESTORE_CHECKLIST.md)에 기록한다.

## 인프라 담당자가 넘겨줄 정보

계정/리전, 자원명·용도, 콘솔 접근 가능 여부, 키/DB 설정을 주입한 실행 위치, 허용 관리 출발지, 백업 식별자·완료 시각, 격리 복원 대상, 승인 RPO/RTO, 시험 기간·예산·정리 담당자. 비밀값과 원본 사진은 이 목록에 첨부하지 않는다.

## 확인한 공식 문서

2026-10-27 기준으로 인계 조건을 확인했다. 구체적인 자원값과 접근 규칙은 실제 배포 후 다시 검토한다.

- [Object Storage 버킷 권한 관리](https://guide.ncloud-docs.com/docs/objectstorage-use-bucket)
- [Object Storage 파일 공개 설정](https://guide.ncloud-docs.com/docs/objectstorage-use-file)
- [Cloud DB for MySQL Backup·복원](https://guide.ncloud-docs.com/docs/database-database-5-4)
- [NAS 개요·암호화·스냅샷](https://guide.ncloud-docs.com/docs/nas-overview)
- [NAS 볼륨·스냅샷 설정](https://guide.ncloud-docs.com/docs/nas-use-nasvolume-vpc)
- [Load Balancer 연결·ACG 점검](https://guide.ncloud-docs.com/docs/loadbalancer-troubleshoot-common)
