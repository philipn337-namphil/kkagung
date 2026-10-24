-- CreateTable
CREATE TABLE `daily_fortunes` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `fortune_date` DATE NOT NULL,
    `grade` ENUM('BAD', 'NORMAL', 'GOOD', 'GREAT') NOT NULL,
    `score` TINYINT UNSIGNED NOT NULL,
    `card_count` TINYINT NOT NULL,
    `message` VARCHAR(200) NOT NULL,
    `opened_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `daily_fortunes_user_id_fortune_date_key`(`user_id`, `fortune_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recommendation_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `viewer_id` BIGINT NOT NULL,
    `target_user_id` BIGINT NOT NULL,
    `recommendation_date` DATE NOT NULL,
    `source_type` ENUM('INITIAL', 'REFRESH') NOT NULL,
    `display_order` TINYINT NOT NULL,
    `reason_code` VARCHAR(40) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `recommendation_items_viewer_id_recommendation_date_source_ty_idx`(`viewer_id`, `recommendation_date`, `source_type`),
    UNIQUE INDEX `recommendation_items_viewer_id_target_user_id_recommendation_key`(`viewer_id`, `target_user_id`, `recommendation_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_refresh_inventory` (
    `service_date` DATE NOT NULL,
    `total_count` INTEGER NOT NULL,
    `remaining_count` INTEGER NOT NULL,
    `granted_count` INTEGER NOT NULL DEFAULT 0,
    `configured_by_admin_id` BIGINT NULL,
    `configured_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`service_date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `token_date` DATE NOT NULL,
    `status` ENUM('AVAILABLE', 'USED', 'EXPIRED') NOT NULL DEFAULT 'AVAILABLE',
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `granted_rank` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `refresh_tokens_token_date_granted_rank_idx`(`token_date`, `granted_rank`),
    UNIQUE INDEX `refresh_tokens_user_id_token_date_key`(`user_id`, `token_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `blocks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `blocker_id` BIGINT NOT NULL,
    `target_user_id` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `blocks_target_user_id_blocker_id_idx`(`target_user_id`, `blocker_id`),
    UNIQUE INDEX `blocks_blocker_id_target_user_id_key`(`blocker_id`, `target_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `daily_fortunes` ADD CONSTRAINT `daily_fortunes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recommendation_items` ADD CONSTRAINT `recommendation_items_viewer_id_fkey` FOREIGN KEY (`viewer_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recommendation_items` ADD CONSTRAINT `recommendation_items_target_user_id_fkey` FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_token_date_fkey` FOREIGN KEY (`token_date`) REFERENCES `daily_refresh_inventory`(`service_date`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blocks` ADD CONSTRAINT `blocks_blocker_id_fkey` FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blocks` ADD CONSTRAINT `blocks_target_user_id_fkey` FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
