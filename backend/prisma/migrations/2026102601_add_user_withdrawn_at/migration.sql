-- 탈퇴는 계정 행을 지우지 않고 status 를 WITHDRAWN 으로 바꾼다.
-- 탈퇴 시각을 updated_at 으로 대신하면 이후 다른 변경에 덮여 사라지므로 별도 컬럼을 둔다.
ALTER TABLE `users` ADD COLUMN `withdrawn_at` DATETIME(3) NULL AFTER `adult_verified_at`;
