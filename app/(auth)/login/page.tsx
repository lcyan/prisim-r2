"use client";

import { Suspense, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertTriangle, ArrowRight, Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/i18n/error-messages";
import { preflightTotp, enrollBegin, ApiClientError } from "@/lib/api/client";
import { useAuthEnrollStore } from "@/stores/auth-enroll";
import { pickPostLoginRoute } from "@/lib/auth/redirect";
import { TotpField } from "@/components/features/auth/TotpField";
import { AuthField } from "@/components/features/auth/AuthField";
import { PrismMark } from "@/components/brand/logo";

/**
 * Login page — single-user app. No registration UI by design (admin is seeded
 * via scripts/seed-admin.ts per CLAUDE.md). No password reset in V1.
 *
 * Aesthetic: editorial-spec-sheet. Letterhead at top, centered form, technical
 * footer with build metadata. Amber signal line spans the full top edge.
 */

const T = {
  brandSubtitle: "R2 · 边缘控制台",
  buildBadge: "v1.0 · 本地构建",
  emailLabel: "邮箱",
  emailPlaceholder: "请输入邮箱",
  passwordLabel: "密码",
  authenticating: "正在认证…",
  signIn: "登录",
  signInFailedTitle: "登录失败",
  letterheadTitle: "登录",
  letterheadCenter: "加密",
  loadingFallback: "正在跳转…",
  singleUser1: "单用户实例。可通过",
  singleUser2: "添加账号。",
  footerLeft: "凭据 AES-GCM 加密 · 对象直传 R2",
  footerRight: "cloudflare pages",
} as const;

export default function LoginPage() {
  // useSearchParams must live inside a Suspense boundary so Next.js can
  // bail out to CSR at build time instead of failing static prerender.
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // An explicit callbackUrl from an interrupted navigation (Auth.js sets one
  // when middleware blocks a gated path) wins when it points at a business
  // page; auth pages fall back to the dashboard to avoid login loops.
  const callbackUrl = searchParams.get("callbackUrl");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [otp, setOtp] = useState("");
  const submittingRef = useRef(false);
  const enrollDraft = useAuthEnrollStore();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;

    // Read values from the form via FormData rather than React state. 1Password
    // (and similar password managers) often set `input.value` directly without
    // dispatching a React-tracked change event, so the React state can lag the
    // DOM. FormData always reflects the live DOM value at submit time.
    const formData = new FormData(e.currentTarget);
    const submittedEmail = String(formData.get("email") ?? "").trim();
    const submittedPassword = String(formData.get("password") ?? "");
    const submittedOtp = String(formData.get("otp") ?? "").trim();
    // Keep React state in sync so the UI (errors / disabled / re-renders)
    // reflects what was actually submitted.
    if (submittedEmail !== email) setEmail(submittedEmail);
    if (submittedPassword !== password) setPassword(submittedPassword);
    if (submittedOtp !== otp) setOtp(submittedOtp);

    if (!submittedEmail || !submittedPassword) {
      setError("auth.invalid_credentials");
      submittingRef.current = false;
      return;
    }

    let keepLocked = false;
    setError(null);
    setPending(true);
    try {
      // 1. preflight
      const { enrolled } = await preflightTotp(submittedEmail);

      // 2. enrolled === false → 调 enroll/begin → push /setup/totp
      if (!enrolled) {
        try {
          const begin = await enrollBegin(submittedEmail, submittedPassword);
          enrollDraft.set({
            email: submittedEmail,
            grant: begin.grant,
            otpauthUri: begin.otpauthUri,
            qrSvg: begin.qrSvg,
            secretBase32: begin.secretBase32,
          });
          router.push("/setup/totp");
          keepLocked = true;
          return;
        } catch (err) {
          if (
            err instanceof ApiClientError &&
            err.code === "auth.totp.already_enrolled"
          ) {
            // 罕见竞态:其它会话已绑定 — 回退到三因素流程
            setError("auth.invalid_credentials");
            return;
          }
          if (err instanceof ApiClientError) {
            setError(err.code);
            return;
          }
          setError("auth.upstream_error");
          return;
        }
      }

      // 3. enrolled === true → OTP 必填 + 调 signIn
      if (submittedOtp.length === 0) {
        setError("auth.otp.required");
        return;
      }
      const res = await signIn("credentials", {
        email: submittedEmail,
        password: submittedPassword,
        otp: submittedOtp,
        redirect: false,
      });
      if (!res || res.error) {
        setError("auth.invalid_credentials");
        return;
      }
      router.replace(
        pickPostLoginRoute(callbackUrl, { origin: window.location.origin }),
      );
      router.refresh();
      keepLocked = true;
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.code === "rate_limited" ? "rate_limited" : err.code);
        return;
      }
      setError("auth.upstream_error");
    } finally {
      if (!keepLocked) {
        submittingRef.current = false;
        setPending(false);
      }
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      <SignalLine />

      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <PrismMark size={22} />
          <span className="text-display text-lg font-semibold tracking-tight">
            Prisim
          </span>
          <span className="text-[11px] uppercase tracking-eyebrow text-muted-foreground">
            {T.brandSubtitle}
          </span>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-eyebrow text-muted-foreground">
          {T.buildBadge}
        </p>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[360px]">
          <Letterhead />

          <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
            <AuthField
              label={T.emailLabel}
              icon={Mail}
              invalid={!!error}
              inputProps={{
                type: "email",
                name: "email",
                autoComplete: "email",
                autoFocus: true,
                required: true,
                value: email,
                onChange: (e) => setEmail(e.target.value),
                disabled: pending,
                placeholder: T.emailPlaceholder,
              }}
            />

            <AuthField
              label={T.passwordLabel}
              icon={Lock}
              invalid={!!error}
              inputProps={{
                type: "password",
                name: "password",
                autoComplete: "current-password",
                required: true,
                value: password,
                onChange: (e) => setPassword(e.target.value),
                disabled: pending,
                placeholder: "••••••••••••",
              }}
            />

            <TotpField
              name="otp"
              value={otp}
              onChange={setOtp}
              disabled={pending}
              label="验证码(首次登录可留空)"
            />

            {error ? <ErrorBanner code={error} /> : null}

            <Button
              type="submit"
              size="lg"
              disabled={pending}
              className="group w-full"
            >
              {pending ? T.authenticating : T.signIn}
              {!pending ? (
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              ) : null}
            </Button>
          </form>

          <p className="mt-8 text-center text-xs leading-relaxed text-muted-foreground">
            {T.singleUser1}{" "}
            <code className="rounded bg-secondary px-1 py-0.5 font-mono">
              scripts/seed-admin.ts
            </code>{" "}
            {T.singleUser2}
          </p>
        </div>
      </main>

      <footer className="flex items-center justify-between border-t border-border px-6 py-3">
        <p className="text-xs text-muted-foreground">{T.footerLeft}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {T.footerRight}
        </p>
      </footer>
    </div>
  );
}

function LoginShell() {
  // Suspense fallback while useSearchParams resolves. Matches the form
  // chrome so layout doesn't shift; the actual inputs render once the
  // client takes over.
  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      <SignalLine />
      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[360px] opacity-50">
          <Letterhead />
        </div>
      </main>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function ErrorBanner({ code }: { code: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
    >
      <AlertTriangle
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
        strokeWidth={2}
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-destructive">
          {T.signInFailedTitle}
        </p>
        <p className="mt-0.5 text-xs text-destructive/80">
          {describeError(code)}
        </p>
      </div>
    </div>
  );
}

function Letterhead() {
  return (
    <div className="text-center">
      <h1 className="text-display text-3xl font-semibold tracking-tight">
        {T.letterheadTitle}
      </h1>
      <div className="mx-auto mt-3 flex items-center justify-center gap-2">
        <span className="h-px w-12 bg-border" aria-hidden />
        <span className="text-[11px] uppercase tracking-eyebrow text-muted-foreground">
          {T.letterheadCenter}
        </span>
        <span className="h-px w-12 bg-border" aria-hidden />
      </div>
    </div>
  );
}

function SignalLine() {
  return <div className="h-[2px] w-full bg-primary" aria-hidden />;
}
