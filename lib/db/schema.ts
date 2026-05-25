// lib/db/schema.ts
//
// Drizzle schema for the Prisim R2 D1 database.
// Tables per PRD §3: users, connections, shares, audit_log, sessions, plus
// rate_limit_buckets for the sliding-window limiter (lib/api/rate-limit.ts).
//
// Conventions:
// - Primary keys: ULID strings (text), generated at insert time via `ulid()`.
// - Timestamps: integer mode='timestamp' — drizzle marshals Date <-> unix seconds.
// - Secrets: stored as blob (AES-GCM ciphertext + iv); never read by hand,
//   always go through lib/crypto/aes-gcm.ts.
// - Foreign keys: cascade on delete (users → cascades to connections, sessions,
//   shares, audit_log; connections → cascades to shares, audit_log) so a user
//   removal cleans up everything they own.
//
// Indexes are defined in the third arg of sqliteTable; see subtask 3.3.
// Schema file is intentionally framework-agnostic (no 'server-only' import)
// because drizzle-kit imports it from a Node CLI context to generate SQL.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/* ─── users ──────────────────────────────────────────────────── */

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  externalId: text("external_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  // TOTP 二次验证。totp_enabled=false 且 ciphertext IS NULL ⇒ 未绑定。
  // 与 connections 同样使用 AES-GCM,AAD = users.id ULID。
  totpSecretCiphertext: blob("totp_secret_ciphertext", { mode: "buffer" }),
  totpSecretIv: blob("totp_secret_iv", { mode: "buffer" }),
  totpEnabled: integer("totp_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  totpConfirmedAt: integer("totp_confirmed_at", { mode: "timestamp" }),
});

/* ─── connections ────────────────────────────────────────────── */

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    accountId: text("account_id").notNull(),
    endpoint: text("endpoint").notNull(),
    accessKeyMasked: text("access_key_masked").notNull(),
    accessKeyCiphertext: blob("access_key_ciphertext", {
      mode: "buffer",
    }).notNull(),
    accessKeyIv: blob("access_key_iv", { mode: "buffer" }).notNull(),
    secretKeyCiphertext: blob("secret_key_ciphertext", {
      mode: "buffer",
    }).notNull(),
    secretKeyIv: blob("secret_key_iv", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (t) => [index("idx_connections_user").on(t.userId)],
);

/* ─── shares ─────────────────────────────────────────────────── */

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    urlHash: text("url_hash").notNull(),
    ttlSeconds: integer("ttl_seconds").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_shares_user_active").on(t.userId, t.expiresAt)],
);

/* ─── audit_log ──────────────────────────────────────────────── */

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    // user_id nullable: failed-login / pre-session events have no user yet.
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectionId: text("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    op: text("op").notNull(),
    bucket: text("bucket"),
    objectKey: text("object_key"),
    status: text("status").notNull(),
    errorMsg: text("error_msg"),
    ip: text("ip"),
    ua: text("ua"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // DESC ordering matches the read pattern: most-recent-first audit lookups.
    index("idx_audit_user_time").on(t.userId, sql`${t.createdAt} DESC`),
  ],
);

/* ─── rate_limit_buckets ─────────────────────────────────────── */

// Sliding-window rate limiter state. One row per limit key
// (e.g. `login:ip:1.2.3.4`, `presign:user:01HXYZ…`). The atomic UPSERT
// in lib/api/rate-limit.checkLimit increments `count` for the active
// window and resets `count`+`window_start` when the window expires.
// `window_start` is stored as epoch milliseconds (same unit checkLimit
// uses for windowMs arithmetic). No FK to users on purpose — pre-auth
// limits (login, anonymous IP buckets) need to write before any user
// row exists.
export const rateLimitBuckets = sqliteTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull(),
});

/* ─── sessions ───────────────────────────────────────────────── */

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  // sha256(rawCsrfToken). Nullable because rows created before this column
  // existed have no token; new rows are always populated by createSession().
  // Verification is via lib/api/middleware.requireCsrf — see lib/auth/csrf.ts
  // for the full design rationale.
  csrfTokenHash: text("csrf_token_hash"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* ─── totp_enrollments ──────────────────────────────────────────
 *
 * 短期绑定 grant。/api/auth/totp/enroll/begin 在此插入候选 secret + grant
 * 哈希,/api/auth/totp/enroll/complete 验证后删除该行。
 * `expires_at` 由 begin 设为 now + 10 min。每次 begin 前 DELETE WHERE
 * user_id = ? 清旧。
 */
export const totpEnrollments = sqliteTable(
  "totp_enrollments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantHash: text("grant_hash").notNull(),
    secretCiphertext: blob("secret_ciphertext", { mode: "buffer" }).notNull(),
    secretIv: blob("secret_iv", { mode: "buffer" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_totp_enroll_user").on(t.userId)],
);

/* ─── recovery_codes ────────────────────────────────────────────
 *
 * 10 行/用户。consumedAt IS NULL 才有效。原始 base32 码 仅在 enroll/complete
 * 返回响应中展示一次,DB 只存 sha256(code)。
 */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_recovery_user_active").on(t.userId, t.consumedAt),
    // 强制 (userId, codeHash) 唯一,避免极小概率 sha256 碰撞时 UPDATE
    // 误命中他人的码。表上限 10 行/用户,该索引代价可忽略。
    uniqueIndex("uniq_recovery_user_hash").on(t.userId, t.codeHash),
  ],
);

/* ─── totp_replay_guard ─────────────────────────────────────────
 *
 * 单行/用户。`last_step` = 已消费的最大 step (unix_seconds / 30)。
 * authorize() 在 OTP 验证成功时 UPSERT 更新,使同一 code 即便在 ±1 step
 * 容差内也无法被重放。
 */
export const totpReplayGuard = sqliteTable("totp_replay_guard", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastStep: integer("last_step").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* ─── sign_in_grants ────────────────────────────────────────────
 *
 * 一次性入会票据。/api/auth/totp/enroll/complete 写入,authorize() 通过
 * { signInGrant } 路径消费。consumedAt IS NULL 才有效。TTL 5 min。
 */
export const signInGrants = sqliteTable(
  "sign_in_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantHash: text("grant_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_signin_grant_hash").on(t.grantHash)],
);

/* ─── inferred types ─────────────────────────────────────────── */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucket = typeof rateLimitBuckets.$inferInsert;
export type TotpEnrollment = typeof totpEnrollments.$inferSelect;
export type NewTotpEnrollment = typeof totpEnrollments.$inferInsert;
export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type NewRecoveryCode = typeof recoveryCodes.$inferInsert;
export type TotpReplayGuard = typeof totpReplayGuard.$inferSelect;
export type NewTotpReplayGuard = typeof totpReplayGuard.$inferInsert;
export type SignInGrant = typeof signInGrants.$inferSelect;
export type NewSignInGrant = typeof signInGrants.$inferInsert;

/* ─── re-export for drizzle client (schema bag) ──────────────── */

export const schema = {
  users,
  connections,
  shares,
  auditLog,
  sessions,
  rateLimitBuckets,
  totpEnrollments,
  recoveryCodes,
  totpReplayGuard,
  signInGrants,
};
