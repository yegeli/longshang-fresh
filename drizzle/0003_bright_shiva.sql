CREATE TABLE `inventory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`order_id` text,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_event_action" CHECK("inventory_events"."action" in ('adjusted','reserved','released','release_review')),
	CONSTRAINT "inventory_event_before" CHECK("inventory_events"."before_json" is null or json_valid("inventory_events"."before_json")),
	CONSTRAINT "inventory_event_after" CHECK(json_valid("inventory_events"."after_json"))
);
--> statement-breakpoint
CREATE INDEX `inventory_events_product_created` ON `inventory_events` (`product_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_events_order_action` ON `inventory_events` (`order_id`,`product_id`,`action`);--> statement-breakpoint
CREATE TABLE `product_inventory` (
	`product_id` text PRIMARY KEY NOT NULL,
	`small_stock` integer NOT NULL,
	`family_stock` integer NOT NULL,
	`batch_id` text NOT NULL,
	`batch_code` text NOT NULL,
	`harvest_date` text NOT NULL,
	`note` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_small_stock" CHECK("product_inventory"."small_stock" >= 0 and "product_inventory"."small_stock" <= 9007199254740991),
	CONSTRAINT "inventory_family_stock" CHECK("product_inventory"."family_stock" >= 0 and "product_inventory"."family_stock" <= 9007199254740991),
	CONSTRAINT "inventory_version" CHECK("product_inventory"."version" >= 1 and "product_inventory"."version" <= 9007199254740991)
);
