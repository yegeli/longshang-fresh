CREATE TABLE `setup_operations` (
	`operation_key` text PRIMARY KEY NOT NULL,
	`request_nonce` text NOT NULL,
	`summary_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "setup_summary_json" CHECK(json_valid("setup_operations"."summary_json") and json_type("setup_operations"."summary_json") = 'object')
);
