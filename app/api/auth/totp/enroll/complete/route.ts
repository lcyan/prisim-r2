// app/api/auth/totp/enroll/complete/route.ts
//
// 首次绑定 step 2:验候选 secret 是否对得上用户输入的 6 位码 → 落库
// (users.totp_enabled=1) + 10 个恢复码 sha256 → 颁发一次性 signInGrant。
// 响应中的 recoveryCodes 是这些码唯一一次以明文出现的地方。
//
// 注意:enrollment 行在 consumeEnrollment 中 atomic DELETE … RETURNING,
// 因此即使 code 验证失败,该 grant 也已被消费,用户需重新走 enroll/begin。
// 这是有意为之 — 防止在 10 分钟绑定窗口内对 6 位 secret 暴力破解。
//
// 流程(对应 spec):
//   1. 查用户(by email)。
//   2. consumeEnrollment(atomic DELETE+RETURNING):缺失/过期/grant 不对 → 410。
//   3. 用 enrollment 里的 secret 解密(AAD = userId)、base32Decode。
//   4. verifyTotpCode(±1 step):错码 → 400。
//   5. 防御性 replay-guard 检查(首次绑定时通常 oldStep 为空,真值时这条意义不大)。
//   6. encryptCredential 用 fresh IV 重新加密后 upsertUserTotp;避免长存
//      的 users.* 行与即将被丢弃的 totp_enrollments 行共享 IV bytes。
//   7. 生成 10 个恢复码 → hashRecoveryCode → insertRecoveryCodesForUser
//      (内部 DELETE+INSERT,清掉历史)。
//   8. upsertReplayGuard 到匹配的 step。
//   9. 颁发 signInGrant ULID,TTL 5 min。
//  10. 审计 + 返回 { recoveryCodes, signInGrant }。
//
// 反账号枚举:user-not-found 与 grant 不对都返回 410 totp.grant_expired,
// 不暴露 "邮箱不存在" 信号。
// 限流:authTotpEnrollByIp(每 IP 15 分钟 5 次,与 begin 同一桶)。

import "server-only";

import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { withPublicApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, TotpEnrollCompleteSchema } from "@/lib/api/schemas";
import {
  decryptCredential,
  encryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { logAudit } from "@/lib/audit/log";
import { verifyTotpCode, base32Decode } from "@/lib/auth/totp";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/recovery-codes";
import {
  consumeEnrollment,
  upsertUserTotp,
  insertRecoveryCodesForUser,
  upsertReplayGuard,
  createSignInGrant,
  getReplayGuardStep,
} from "@/lib/auth/totp-store";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

const SIGN_IN_GRANT_TTL_MS = 5 * 60 * 1000;

type CompleteEnv = DbEnv & CryptoEnv;

export const POST = withPublicApi(
  async (req) => {
    const { email, grant, code } = await parseJson(
      req,
      TotpEnrollCompleteSchema,
    );
    const env = getRequestContext().env as unknown as CompleteEnv;
    const db = getDb(env);

    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
      columns: { id: true },
    });
    if (!user) {
      // 反枚举:user-not-found 与 grant-not-found 共用 410。
      throw ApiErrors.totpGrantExpired();
    }

    // Atomic DELETE…RETURNING — null 表示 (userId, grant) 不匹配或已过期。
    // 这里"消费即失效"是有意的:即使下面 code 验证失败,该 grant 也已废,
    // 防止 10 min 窗口内暴力枚举 6 位 TOTP。
    const enrollment = await consumeEnrollment(db, {
      userId: user.id,
      grant,
    });
    if (!enrollment) {
      await logAudit({
        userId: user.id,
        op: "auth.totp.enroll.complete",
        status: "failure",
        errorMsg: "grant_expired",
        req,
      });
      throw ApiErrors.totpGrantExpired();
    }

    let secretBase32Plain: string;
    try {
      secretBase32Plain = await decryptCredential(
        enrollment.secretCiphertext,
        enrollment.secretIv,
        user.id,
        env,
      );
    } catch {
      // ciphertext / AAD / 主密钥任意一项被改动 → 视同 grant 失效。
      await logAudit({
        userId: user.id,
        op: "auth.totp.enroll.complete",
        status: "failure",
        errorMsg: "decrypt_failed",
        req,
      });
      throw ApiErrors.totpGrantExpired();
    }
    const secretBytes = base32Decode(secretBase32Plain);

    const verify = await verifyTotpCode(
      secretBytes,
      code,
      Math.floor(Date.now() / 1000),
    );
    if (!verify.ok) {
      await logAudit({
        userId: user.id,
        op: "auth.totp.enroll.complete",
        status: "failure",
        errorMsg: "code_invalid",
        req,
      });
      throw ApiErrors.totpInvalidCode();
    }

    // 防御性:首次绑定理应没有旧 replay guard 行,但保留检查以防回旋绑定
    // (如 reset 路径未来上线时复用本接口)。
    const oldStep = await getReplayGuardStep(db, user.id);
    if (oldStep != null && verify.matchedStep! <= oldStep) {
      await logAudit({
        userId: user.id,
        op: "auth.totp.enroll.complete",
        status: "failure",
        errorMsg: "replay",
        req,
      });
      throw ApiErrors.totpReplay();
    }

    // 用 fresh IV 重新加密,避免长期 users.* 行与 throwaway enrollment 行
    // 共享相同 (key, iv) — GCM 重用 (key, iv) 是灾难。
    const { iv, ciphertext } = await encryptCredential(
      secretBase32Plain,
      user.id,
      env,
    );
    await upsertUserTotp(db, {
      userId: user.id,
      secretCiphertext: ciphertext,
      secretIv: iv,
    });

    // 10 个恢复码;sha256 后批量入库(insertRecoveryCodesForUser 内部
    // 先 DELETE 后 INSERT,确保旧码不残留)。
    const recoveryCodes = generateRecoveryCodes();
    const hashes = await Promise.all(
      recoveryCodes.map((c) => hashRecoveryCode(c, user.id)),
    );
    await insertRecoveryCodesForUser(db, { userId: user.id, hashes });

    await upsertReplayGuard(db, {
      userId: user.id,
      step: verify.matchedStep!,
    });

    const signInGrant = ulid();
    await createSignInGrant(db, {
      userId: user.id,
      grant: signInGrant,
      ttlMs: SIGN_IN_GRANT_TTL_MS,
    });

    await logAudit({
      userId: user.id,
      op: "auth.totp.enroll.complete",
      status: "success",
      req,
    });

    return { recoveryCodes, signInGrant };
  },
  {
    rateLimit: ({ ip }) => RateLimitBundles.authTotpEnrollByIp(ip),
  },
);
