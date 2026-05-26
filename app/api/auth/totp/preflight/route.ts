// app/api/auth/totp/preflight/route.ts
//
// 登录前查询:邮箱对应的账号是否已绑定 TOTP。
//
// 用途:/login 在用户输入邮箱后调用此 endpoint,据此决定下一步表单是
//   * 显示「密码」单字段(未绑定 → 走密码登录;首次登录后引导绑定),还是
//   * 显示「密码 + 6 位 TOTP 代码」(已绑定)。
//
// 反帐号枚举:
//   邮箱不存在  → { enrolled: false }
//   邮箱存在但 totp_enabled=0 → { enrolled: false }
//   邮箱存在且 totp_enabled=1 → { enrolled: true }
// 不存在与未绑定两条分支响应完全一致,攻击者无法靠此 endpoint 区分。
//
// 限流:每个 IP 5 分钟 10 次(authTotpPreflightByIp);避免暴力探测枚举。
// 无 session / 无 CSRF — withPublicApi 直接进 handler。

import "server-only";

import { eq } from "drizzle-orm";

import { withPublicApi } from "@/lib/api/middleware";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, TotpPreflightSchema } from "@/lib/api/schemas";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

export const POST = withPublicApi(
  async (req) => {
    const { email } = await parseJson(req, TotpPreflightSchema);
    const env = getRequestContext().env as unknown as DbEnv;
    const db = getDb(env);
    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
      columns: { totpEnabled: true },
    });
    return { enrolled: Boolean(user?.totpEnabled) };
  },
  {
    rateLimit: ({ ip }) => RateLimitBundles.authTotpPreflightByIp(ip),
  },
);
