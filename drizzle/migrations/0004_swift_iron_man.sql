DROP INDEX `idx_recovery_user_hash`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_recovery_user_hash` ON `recovery_codes` (`user_id`,`code_hash`);