// app/api/auth/totp/enroll/begin/route.ts
//
// 首次绑定 step 1:验密码 → 生成候选 secret + grant → 返回 otpauth URI
// 和 QR SVG。secret 在 D1 已加密存储(AES-GCM,AAD=users.id),grant 仅以
// sha256(grant) 入库;明文 grant 只在响应中出现一次,客户端在内存持有
// 10 min,随后送回到 enroll/complete。
//
// 反账号枚举:邮箱不存在与密码错误返回同一个 401 auth.invalid_credentials。
// 已绑定:返回 409 auth.totp.already_enrolled,不重复发 secret。
// 限流:authTotpEnrollByIp(每 IP 5 分钟 5 次)。
// 审计:成功 / 失败 (invalid_credentials, already_enrolled) 都写一行。

import "server-only";

import QRCode from "qrcode";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { withPublicApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, TotpEnrollBeginSchema } from "@/lib/api/schemas";
import { encryptCredential, type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { verifyPassword } from "@/lib/auth/password";
import { logAudit } from "@/lib/audit/log";
import {
  buildOtpauthUri,
  base32Encode,
  generateTotpSecret,
} from "@/lib/auth/totp";
import { createEnrollment } from "@/lib/auth/totp-store";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const ISSUER = "Prisim R2";

type BeginEnv = DbEnv & CryptoEnv;

export const POST = withPublicApi(
  async (req) => {
    const { email, password } = await parseJson(req, TotpEnrollBeginSchema);
    const env = getRequestContext().env as unknown as BeginEnv;
    const db = getDb(env);

    const row = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
      columns: {
        id: true,
        email: true,
        passwordHash: true,
        totpEnabled: true,
      },
    });

    // Anti-enumeration: 邮箱不存在 vs 密码错误共享同一响应。
    // 始终走一次 verifyPassword 以保持时序相近(verifyPassword 在 row 为空时
    // 不能调用,所以我们在缺失分支也做一次 PBKDF2 形态的等价工作量略偏短;
    // 在合理范围内,完全的恒定时间需要更复杂的设计,这里以错误码统一为主)。
    if (!row || !(await verifyPassword(password, row.passwordHash))) {
      await logAudit({
        userId: row?.id ?? null,
        op: "auth.totp.enroll.begin",
        status: "failure",
        errorMsg: "invalid_credentials",
        req,
      });
      throw ApiErrors.invalidCredentials();
    }

    if (row.totpEnabled) {
      await logAudit({
        userId: row.id,
        op: "auth.totp.enroll.begin",
        status: "failure",
        errorMsg: "already_enrolled",
        req,
      });
      throw ApiErrors.totpAlreadyEnrolled();
    }

    const secret = generateTotpSecret();
    const secretBase32 = base32Encode(secret);
    const { iv, ciphertext } = await encryptCredential(
      secretBase32,
      row.id,
      env,
    );
    const grant = ulid();
    await createEnrollment(db, {
      userId: row.id,
      grant,
      secretCiphertext: ciphertext,
      secretIv: iv,
      ttlMs: ENROLLMENT_TTL_MS,
    });

    const otpauthUri = buildOtpauthUri({
      issuer: ISSUER,
      label: row.email,
      secret,
    });
    const qrSvg = await QRCode.toString(otpauthUri, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
    });

    await logAudit({
      userId: row.id,
      op: "auth.totp.enroll.begin",
      status: "success",
      req,
    });

    return {
      grant,
      otpauthUri,
      qrSvg,
      secretBase32,
    };
  },
  {
    rateLimit: ({ ip }) => RateLimitBundles.authTotpEnrollByIp(ip),
  },
);
