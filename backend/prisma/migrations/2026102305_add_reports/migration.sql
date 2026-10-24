-- CreateTable
CREATE TABLE `reports` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `reporter_id` BIGINT NOT NULL,
    `target_type` ENUM('USER', 'MESSAGE') NOT NULL,
    `target_id` BIGINT NOT NULL,
    `reason_code` ENUM('SPAM', 'ABUSE', 'SEXUAL', 'FAKE_PROFILE', 'UNDERAGE', 'OTHER') NOT NULL,
    `detail` VARCHAR(500) NULL,
    `status` ENUM('PENDING', 'REVIEWING', 'RESOLVED', 'DISMISSED') NOT NULL DEFAULT 'PENDING',
    `handled_by_admin_id` BIGINT NULL,
    `handled_at` DATETIME(3) NULL,
    `result_note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `reports_status_created_at_idx`(`status`, `created_at`),
    INDEX `reports_reporter_id_target_type_target_id_reason_code_status_idx`(`reporter_id`, `target_type`, `target_id`, `reason_code`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `reports` ADD CONSTRAINT `reports_reporter_id_fkey` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
