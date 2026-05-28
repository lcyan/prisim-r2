// app/api/r2/mkdir/route.ts
//
// POST /api/r2/mkdir
//
// Creates a "folder" by writing a 0-byte object at `parentPrefix + name + "/"`.
// AWS Console / s3cmd compatible — list responses surface the placeholder
// both in CommonPrefixes (so it appears as a folder) and as a 0-byte
// object in Contents (hooks/use-objects.ts filters the latter out).
//
// Body  : R2MkdirSchema (cid, bucket, parentPrefix, name).
// Errors:
//   r2.folder_invalid_name (400) — name failed validateFolderName
//                                  (".", "..", reserved, control char, …)
//   r2.folder_too_deep     (400) — parentPrefix+name+"/" > 1024 bytes
//   auth.unauthorized      (401) — R2 credentials rejected by upstream
//   resource.not_found     (404) — connection row not owned by user
//   rate_limited           (429) — write-aggregate cap (600/min/user)

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { parseJson, R2MkdirSchema } from "@/lib/api/schemas";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import type { R2MkdirResponse } from "@/lib/api/types";
import {
  validateFolderName,
  describeFolderNameError,
} from "@/lib/r2/folder-name";
import { putEmptyObject } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import {
  resolveConnectionForR2,
  touchConnectionLastUsed,
} from "@/lib/r2/route-helpers";
import { logAudit } from "@/lib/audit/log";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";

type MkdirEnv = DbEnv & CryptoEnv;

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2MkdirSchema);
    const env = getCloudflareContext().env as unknown as MkdirEnv;

    // Second-line validation (regex passed but ".", "..", reserved names
    // would slip through — see lib/r2/folder-name.ts).
    const nameResult = validateFolderName(input.name);
    if (!nameResult.ok) {
      // Audit even invalid attempts (security-relevant: maps attempts to
      // craft path-traversal-ish keys). Second arg is the optional db
      // override — production callers omit it so logAudit resolves the
      // binding via getCloudflareContext(); passing `undefined` explicitly
      // keeps the call shape uniform across audit sites in this file.
      await logAudit(
        {
          userId: ctx.userId,
          connectionId: input.cid,
          op: "r2.mkdir",
          bucket: input.bucket,
          key: `${input.parentPrefix}${input.name}/`,
          status: "failure",
          errorMsg: `folder_invalid_name:${nameResult.reason}`,
          req,
        },
        undefined,
      );
      throw ApiErrors.r2FolderInvalidName(
        describeFolderNameError(nameResult.reason),
      );
    }

    const key = `${input.parentPrefix}${nameResult.name}/`;
    if (new TextEncoder().encode(key).length > 1024) {
      await logAudit(
        {
          userId: ctx.userId,
          connectionId: input.cid,
          op: "r2.mkdir",
          bucket: input.bucket,
          key,
          status: "failure",
          errorMsg: "folder_too_deep",
          req,
        },
        undefined,
      );
      throw ApiErrors.r2FolderTooDeep();
    }

    const { db, connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "mkdir",
      auditBucket: input.bucket,
      auditKey: key,
    });

    let result: { alreadyExisted: boolean };
    try {
      result = await putEmptyObject({
        client,
        bucket: input.bucket,
        key,
      });
    } catch (err) {
      await logAudit(
        {
          userId: ctx.userId,
          connectionId: connection.id,
          op: "r2.mkdir",
          bucket: input.bucket,
          key,
          status: "failure",
          errorMsg: err instanceof Error ? err.message : "r2_upstream",
          req,
        },
        undefined,
      );
      if (err instanceof R2CredentialError) {
        throw ApiErrors.unauthorized("R2 credentials rejected");
      }
      throw err;
    }

    await logAudit(
      {
        userId: ctx.userId,
        connectionId: connection.id,
        op: "r2.mkdir",
        bucket: input.bucket,
        key,
        status: "success",
        errorMsg: result.alreadyExisted ? "already_existed" : null,
        req,
      },
      undefined,
    );

    await touchConnectionLastUsed(db, {
      connectionId: connection.id,
      userId: ctx.userId,
      requestId: ctx.requestId,
      tag: "mkdir",
    });

    const body: R2MkdirResponse = { key, alreadyExisted: result.alreadyExisted };
    return body;
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
