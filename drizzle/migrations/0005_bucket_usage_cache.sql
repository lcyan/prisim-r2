CREATE TABLE `bucket_usage_cache` (
  `user_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `bucket` text NOT NULL,
  `object_count` integer NOT NULL DEFAULT 0,
  `total_bytes` integer NOT NULL DEFAULT 0,
  `scanned_at` integer,
  `stale` integer NOT NULL DEFAULT 0,
  `truncated` integer NOT NULL DEFAULT 0,
  `error_msg` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (`user_id`, `connection_id`, `bucket`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_bucket_usage_connection` ON `bucket_usage_cache` (`connection_id`);
