CREATE TABLE `buyer_order_consumptions` (
	`order_id` text PRIMARY KEY NOT NULL,
	`buyer_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `buyer_order_consumptions_buyer` ON `buyer_order_consumptions` (`buyer_id`);--> statement-breakpoint
CREATE TABLE `buyer_shopping` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "buyer_shopping_json" CHECK(json_valid("buyer_shopping"."state_json") and json_type("buyer_shopping"."state_json") = 'object'),
	CONSTRAINT "buyer_shopping_version" CHECK("buyer_shopping"."version" >= 1 and "buyer_shopping"."version" <= 9007199254740991)
);
