// stores/auth-enroll.ts
//
// 首次绑定期间的瞬时状态。/login 验证密码并调 enroll/begin 拿到
// { grant, otpauthUri, qrSvg, secretBase32 } 后写入这里,push 到
// /setup/totp 后由该页面消费。
//
// **不 persist**:任何 sessionStorage/localStorage 写入都会让密文长期
// 留在浏览器,违反 CLAUDE.md 凭据约束。刷新 /setup/totp 时 store 为空
// → 页面 redirect 回 /login。

"use client";

import { create } from "zustand";

interface AuthEnrollState {
  email: string | null;
  grant: string | null;
  otpauthUri: string | null;
  qrSvg: string | null;
  secretBase32: string | null;
  set: (data: {
    email: string;
    grant: string;
    otpauthUri: string;
    qrSvg: string;
    secretBase32: string;
  }) => void;
  clear: () => void;
}

export const useAuthEnrollStore = create<AuthEnrollState>((set) => ({
  email: null,
  grant: null,
  otpauthUri: null,
  qrSvg: null,
  secretBase32: null,
  set: (data) =>
    set({
      email: data.email,
      grant: data.grant,
      otpauthUri: data.otpauthUri,
      qrSvg: data.qrSvg,
      secretBase32: data.secretBase32,
    }),
  clear: () =>
    set({
      email: null,
      grant: null,
      otpauthUri: null,
      qrSvg: null,
      secretBase32: null,
    }),
}));
