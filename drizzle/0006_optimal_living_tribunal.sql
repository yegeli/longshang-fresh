CREATE TABLE `wechat_identities` (
	`subject_hash` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_identities_user_id_unique` ON `wechat_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `wechat_login_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`request_nonce` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wechat_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `wechat_sessions_user` ON `wechat_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `wechat_sessions_expiry` ON `wechat_sessions` (`expires_at`);