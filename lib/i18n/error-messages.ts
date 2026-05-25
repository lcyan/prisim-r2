// lib/i18n/error-messages.ts
//
// API 错误码 → 用户可读的中文文案。Sub-spec 1 只覆盖 V1 现有的 code；
// 新加的 code 随实现随补。describeError 用兜底 "操作失败（<code>）"
// 防止漏映射导致界面显示空白。

export const ERROR_MESSAGES: Record<string, string> = {
  // 后端 ApiErrorCode（lib/api/errors.ts 的 11 个枚举）
  "auth.unauthorized": "请先登录",
  "auth.forbidden": "没有权限执行该操作",
  "csrf.invalid": "会话已过期，请刷新页面",
  "validation.invalid": "请求参数有误",
  "resource.not_found": "找不到对应的资源",
  "resource.conflict": "资源状态冲突，请刷新后重试",
  "confirmation.required": "请输入对应名称以确认",
  "rate_limited": "操作过于频繁，请稍后再试",
  "connection.invalid_credentials": "R2 凭据无效或已过期",
  "connection.in_use": "连接被引用中，无法删除",
  "internal.unexpected": "服务出现异常，请稍后再试",
  // 前端自定义码（next-auth signIn 不抛 ApiError 而是 opaque "CredentialsSignin"，
  // login 页把它映射为以下两个 code 用于显示）
  "auth.invalid_credentials": "邮箱或密码错误",
  "auth.upstream_error": "认证服务暂时不可用，请稍后再试",
  // TOTP 二次验证
  "auth.totp.enrollment_required": "首次登录需要绑定 Authenticator",
  "auth.totp.invalid_code": "验证码错误或已过期",
  "auth.totp.replay": "该验证码已被使用过",
  "auth.totp.grant_expired": "绑定流程已超时,请重新开始",
  "auth.totp.already_enrolled": "该账号已绑定 TOTP",
  "auth.recovery_code.invalid": "恢复码无效或已使用",
  // 表单本地校验
  "auth.otp.required": "请输入验证码",
};

export function describeError(code: string | undefined | null): string {
  if (!code) return "未知错误";
  return ERROR_MESSAGES[code] ?? `操作失败（${code}）`;
}
