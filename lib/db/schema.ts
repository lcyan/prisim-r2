// lib/db/schema.ts
//
// Drizzle schema for the Prisim R2 D1 database.
// Five tables per PRD §3: users, connections, shares, audit_log, sessions.
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

/* ─── re-export for drizzle client (schema bag) ──────────────── */

export const schema = {
  users,
  connections,
  shares,
  auditLog,
  sessions,
};
