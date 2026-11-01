CREATE TABLE `admin_bootstrap` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`claimed_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "one_admin_bootstrap" CHECK("admin_bootstrap"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "media_kind" CHECK("media"."kind" in ('image', 'video')),
	CONSTRAINT "media_type" CHECK(("media"."kind" = 'image' and "media"."mime_type" in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')) or ("media"."kind" = 'video' and "media"."mime_type" in ('video/mp4', 'video/webm'))),
	CONSTRAINT "media_size" CHECK("media"."size" > 0 and (("media"."kind" = 'image' and "media"."size" <= 5242880) or ("media"."kind" = 'video' and "media"."size" <= 31457280))),
	CONSTRAINT "media_source" CHECK(length("media"."source") between 1 and 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_object_key_unique` ON `media` (`object_key`);--> statement-breakpoint
CREATE INDEX `media_owner` ON `media` (`owner_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`product_json` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`image_media_id` text,
	`video_media_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`video_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "products_status_valid" CHECK("products"."status" in ('draft', 'published', 'offline')),
	CONSTRAINT "products_version" CHECK("products"."version" >= 1 and "products"."version" <= 9007199254740991),
	CONSTRAINT "products_json" CHECK(json_valid("products"."product_json"))
);
--> statement-breakpoint
CREATE INDEX `products_owner` ON `products` (`owner_id`);--> statement-breakpoint
CREATE INDEX `products_status` ON `products` (`status`);--> statement-breakpoint
CREATE INDEX `products_image_media` ON `products` (`image_media_id`);--> statement-breakpoint
CREATE INDEX `products_video_media` ON `products` (`video_media_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'buyer' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "users_role" CHECK("users"."role" in ('buyer', 'merchant', 'admin'))
);
