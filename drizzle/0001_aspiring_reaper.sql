CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`request_key` text NOT NULL,
	`request_json` text NOT NULL,
	`order_json` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_version" CHECK("orders"."version" >= 1 and "orders"."version" <= 9007199254740991),
	CONSTRAINT "orders_request_json" CHECK(json_valid("orders"."request_json")),
	CONSTRAINT "orders_snapshot_json" CHECK(json_valid("orders"."order_json")),
	CONSTRAINT "orders_status" CHECK(json_extract("orders"."order_json", '$.status') in ('created', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_buyer_request` ON `orders` (`buyer_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `orders_buyer_created` ON `orders` (`buyer_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_seller_created` ON `orders` (`seller_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_created` ON `orders` (`created_at`,`id`);