-- CreateTable
CREATE TABLE `admin_settings` (
    `setting_key` VARCHAR(60) NOT NULL,
    `effective_service_date` DATE NOT NULL,
    `setting_value` JSON NOT NULL,
    `updated_by_admin_id` BIGINT NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`setting_key`, `effective_service_date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_audit_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `admin_id` BIGINT NOT NULL,
    `request_id` VARCHAR(64) NOT NULL,
    `action` VARCHAR(60) NOT NULL,
    `target_type` VARCHAR(30) NOT NULL,
    `target_id` BIGINT NOT NULL,
    `before_value` JSON NULL,
    `after_value` JSON NULL,
    `result` ENUM('SUCCESS', 'FAILURE') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_audit_logs_admin_id_created_at_idx`(`admin_id`, `created_at`),
    INDEX `admin_audit_logs_action_created_at_idx`(`action`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
