-- CreateTable
CREATE TABLE `profile_images` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `slot` TINYINT NOT NULL,
    `image_type` ENUM('ORIGINAL_PRIVATE', 'AI_PUBLIC', 'BLURRED_PUBLIC') NOT NULL,
    `object_key` VARCHAR(255) NOT NULL,
    `generation_status` ENUM('PENDING', 'PROCESSING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `byte_size` INTEGER NOT NULL,
    `width` SMALLINT NOT NULL,
    `height` SMALLINT NOT NULL,
    `processed_at` DATETIME(3) NULL,
    `failed_reason_code` VARCHAR(40) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `profile_images_user_id_image_type_generation_status_idx`(`user_id`, `image_type`, `generation_status`),
    UNIQUE INDEX `profile_images_user_id_slot_image_type_key`(`user_id`, `slot`, `image_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `profile_images` ADD CONSTRAINT `profile_images_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
