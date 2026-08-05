CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`mask` text,
	`type` text
);
--> statement-breakpoint
CREATE TABLE `allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`txn_id` text NOT NULL,
	`line_item_id` text,
	`project_id` text NOT NULL,
	`category` text,
	`cost_type` text,
	`amount_cents` integer NOT NULL,
	`basis` text NOT NULL,
	`provenance` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`rule_id` text,
	`scale_factor` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`txn_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`line_item_id`) REFERENCES `line_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `allocations_txn_idx` ON `allocations` (`txn_id`);--> statement-breakpoint
CREATE INDEX `allocations_project_idx` ON `allocations` (`project_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload` text,
	`log` text DEFAULT '' NOT NULL,
	`error` text,
	`queued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`queued_at`);--> statement-breakpoint
CREATE TABLE `line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`description` text NOT NULL,
	`group_key` text,
	`raw` text,
	`source_doc_id` text,
	FOREIGN KEY (`source_doc_id`) REFERENCES `source_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `line_items_external_idx` ON `line_items` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `line_items_date_idx` ON `line_items` (`date`);--> statement-breakpoint
CREATE INDEX `line_items_group_idx` ON `line_items` (`group_key`);--> statement-breakpoint
CREATE TABLE `overrides` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`category` text,
	`cost_type` text,
	`split_pct` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#2a78d6' NOT NULL,
	`color_dark` text DEFAULT '#3987e5' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`synthetic` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`target` text DEFAULT 'transaction' NOT NULL,
	`scope_source` text,
	`match_pattern` text NOT NULL,
	`match_field` text DEFAULT 'merchant_norm' NOT NULL,
	`min_cents` integer,
	`max_cents` integer,
	`set_project_id` text,
	`set_category` text,
	`set_cost_type` text,
	`note` text,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`set_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rules_priority_idx` ON `rules` (`priority`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text,
	`stored_path` text,
	`content_hash` text NOT NULL,
	`period_start` text,
	`period_end` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`ingested_at` integer DEFAULT (unixepoch()) NOT NULL,
	`meta` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_documents_hash_idx` ON `source_documents` (`source`,`content_hash`);--> statement-breakpoint
CREATE TABLE `source_state` (
	`source` text PRIMARY KEY NOT NULL,
	`connected` integer DEFAULT false NOT NULL,
	`last_sync_at` integer,
	`last_sync_status` text DEFAULT 'never' NOT NULL,
	`last_error` text,
	`cursor` text,
	`config` text
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`merchant_raw` text NOT NULL,
	`merchant_norm` text NOT NULL,
	`account_id` text,
	`copilot_category` text,
	`notes` text,
	`pending` integer DEFAULT false NOT NULL,
	`reverses_txn_id` text,
	`source_doc_id` text,
	`content_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_doc_id`) REFERENCES `source_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_merchant_idx` ON `transactions` (`merchant_norm`);--> statement-breakpoint
CREATE TABLE `txn_line_links` (
	`txn_id` text NOT NULL,
	`line_item_id` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`method` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`txn_id`, `line_item_id`),
	FOREIGN KEY (`txn_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`line_item_id`) REFERENCES `line_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `txn_line_links_txn_idx` ON `txn_line_links` (`txn_id`);