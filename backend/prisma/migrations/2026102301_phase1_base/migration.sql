CREATE TABLE `users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT, `email` VARCHAR(255) NOT NULL, `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('USER','ADMIN') NOT NULL DEFAULT 'USER', `status` ENUM('ACTIVE','RECOMMENDATION_BLOCKED','CHAT_RESTRICTED','SUSPENDED','WITHDRAWN') NOT NULL DEFAULT 'ACTIVE',
  `adult_verified_at` DATETIME(3) NULL, `last_active_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `users_email_key`(`email`), INDEX `users_status_last_active_at_idx`(`status`,`last_active_at`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_profiles` (
  `user_id` BIGINT NOT NULL, `display_name` VARCHAR(30) NOT NULL, `birth_date` DATE NOT NULL,
  `gender` ENUM('MALE','FEMALE','OTHER') NOT NULL, `region_code` VARCHAR(50) NOT NULL, `height_cm` SMALLINT NOT NULL,
  `job_category` ENUM('STUDENT','OFFICE_WORKER','FREELANCER','SELF_EMPLOYED','OTHER') NOT NULL, `mbti` CHAR(4) NOT NULL,
  `energy_type` ENUM('EGEN','TETO','ANY') NULL, `animal_face` VARCHAR(30) NULL, `celebrity_lookalike` VARCHAR(50) NULL,
  `smoking_status` ENUM('SMOKER','NON_SMOKER','ANY') NULL, `tattoo_status` ENUM('YES','NO','ANY') NULL,
  `military_service` ENUM('COMPLETED','NOT_COMPLETED','NOT_APPLICABLE','ANY') NULL, `intro` VARCHAR(200) NULL,
  `profile_completed_at` DATETIME(3) NULL, INDEX `user_profiles_gender_region_code_birth_date_idx`(`gender`,`region_code`,`birth_date`), PRIMARY KEY (`user_id`),
  CONSTRAINT `user_profiles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_preferences` (
  `user_id` BIGINT NOT NULL, `preferred_gender` ENUM('MALE','FEMALE','OTHER') NOT NULL, `min_age` SMALLINT NOT NULL, `max_age` SMALLINT NOT NULL,
  `region_scope` JSON NOT NULL, `energy_type` ENUM('EGEN','TETO','ANY') NOT NULL DEFAULT 'ANY', `animal_face` VARCHAR(30) NULL,
  `min_height_cm` SMALLINT NULL, `smoking_status` ENUM('SMOKER','NON_SMOKER','ANY') NOT NULL DEFAULT 'ANY',
  `tattoo_status` ENUM('YES','NO','ANY') NOT NULL DEFAULT 'ANY', `military_service` ENUM('COMPLETED','NOT_COMPLETED','NOT_APPLICABLE','ANY') NOT NULL DEFAULT 'ANY',
  PRIMARY KEY (`user_id`), CONSTRAINT `user_preferences_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
