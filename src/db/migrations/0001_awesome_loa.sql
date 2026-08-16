CREATE TABLE `logs` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `logs_ts_idx` ON `logs` (`ts`);--> statement-breakpoint
CREATE INDEX `logs_level_idx` ON `logs` (`level`);