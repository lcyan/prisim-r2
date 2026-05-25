CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_recovery_user_active` ON `recovery_codes` (`user_id`,`consumed_at`);--> statement-breakpoint
CREATE INDEX `idx_recovery_user_hash` ON `recovery_codes` (`user_id`,`code_hash`);--> statement-breakpoint
CREATE TABLE `sign_in_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`grant_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_signin_grant_hash` ON `sign_in_grants` (`grant_hash`);--> statement-breakpoint
CREATE TABLE `totp_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`grant_hash` text NOT NULL,
	`secret_ciphertext` blob NOT NULL,
	`secret_iv` blob NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_totp_enroll_user` ON `totp_enrollments` (`user_id`);--> statement-breakpoint
CREATE TABLE `totp_replay_guard` (
	`user_id` text PRIMARY KEY NOT NULL,
	`last_step` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret_ciphertext` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret_iv` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_confirmed_at` integer;