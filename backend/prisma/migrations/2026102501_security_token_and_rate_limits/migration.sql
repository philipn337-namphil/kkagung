CREATE TABLE `revoked_access_tokens` (
    `token_hash` CHAR(64) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `revoked_access_tokens_expires_at_idx` (`expires_at`),
    PRIMARY KEY (`token_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rate_limit_counters` (
    `key_hash` CHAR(64) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 1,
    INDEX `rate_limit_counters_expires_at_idx` (`expires_at`),
    PRIMARY KEY (`key_hash`, `window_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
