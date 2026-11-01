CREATE TABLE `merchant_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`region` text NOT NULL,
	`status` text NOT NULL,
	`permissions_json` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merchant_status" CHECK("merchant_accounts"."status" in ('enabled', 'disabled')),
	CONSTRAINT "merchant_version" CHECK("merchant_accounts"."version" >= 1 and "merchant_accounts"."version" <= 9007199254740991),
	CONSTRAINT "merchant_permissions_json" CHECK(json_valid("merchant_accounts"."permissions_json") and json_type("merchant_accounts"."permissions_json") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_accounts_email_unique` ON `merchant_accounts` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_accounts_user_id_unique` ON `merchant_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `merchant_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchant_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merchant_audit_action" CHECK("merchant_audit"."action" in ('created', 'updated', 'bound')),
	CONSTRAINT "merchant_audit_before" CHECK("merchant_audit"."before_json" is null or json_valid("merchant_audit"."before_json")),
	CONSTRAINT "merchant_audit_after" CHECK(json_valid("merchant_audit"."after_json"))
);
--> statement-breakpoint
CREATE INDEX `merchant_audit_account_created` ON `merchant_audit` (`merchant_id`,`created_at`);