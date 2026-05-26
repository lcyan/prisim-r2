"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertTriangle, ArrowRight, Lock, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeError } from "@/lib/i18n/error-messages";
import {
  preflightTotp,
  enrollBegin,
  ApiClientError,
} from "@/lib/api/client";
import { useAuthEnrollStore } from "@/stores/auth-enroll";
import { TotpField } from "@/components/features/auth/TotpField";

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
  // Default to "/" so the post-login bounce runs through HomeRedirector,
  // which respects the persisted activeBucket and routes the user back
  // to the bucket they were last browsing. An explicit callbackUrl from
  // an interrupted navigation (Auth.js sets one when middleware blocks a
  // gated path) still wins so deep links keep working.
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [otp, setOtp] = useState("");
  const enrollDraft = useAuthEnrollStore();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // 1. preflight
      const { enrolled } = await preflightTotp(email);

      // 2. enrolled === false → 调 enroll/begin → push /setup/totp
      if (!enrolled) {
        try {
          const begin = await enrollBegin(email, password);
          enrollDraft.set({
            email,
            grant: begin.grant,
            otpauthUri: begin.otpauthUri,
            qrSvg: begin.qrSvg,
            secretBase32: begin.secretBase32,
          });
          router.push("/setup/totp");
          return;
        } catch (err) {
          if (err instanceof ApiClientError && err.code === "auth.totp.already_enrolled") {
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
      if (!otp || otp.trim().length === 0) {
        setError("auth.otp.required");
        return;
      }
      const res = await signIn("credentials", {
        email,
        password,
        otp,
        redirect: false,
      });
      if (!res || res.error) {
        setError("auth.invalid_credentials");
        return;
      }
      router.replace(callbackUrl);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.code === "rate_limited" ? "rate_limited" : err.code);
        return;
      }
      setError("auth.upstream_error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      <SignalLine />

      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-lg font-semibold tracking-tight">
            Prisim
          </span>
          <span className="text-xs text-muted-foreground">
            {T.brandSubtitle}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {T.buildBadge}
        </p>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[360px]">
          <Letterhead />

          <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
            <Field
              label={T.emailLabel}
              icon={Mail}
              input={
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={pending}
                  className={cn(inputClass, error && "border-destructive/60")}
                  placeholder={T.emailPlaceholder}
                />
              }
            />

            <Field
              label={T.passwordLabel}
              icon={Lock}
              input={
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={pending}
                  className={cn(inputClass, error && "border-destructive/60")}
                  placeholder="••••••••••••"
                />
              }
            />

            <TotpField
              value={otp}
              onChange={setOtp}
              disabled={pending}
              label="验证码(首次登录可留空)"
            />

            {error ? <ErrorBanner code={error} /> : null}

            <button
              type="submit"
              disabled={pending || !email || !password}
              className={cn(
                "group inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-all",
                "hover:opacity-95 active:translate-y-px",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {pending ? T.authenticating : T.signIn}
              {!pending ? (
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              ) : null}
            </button>
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
        <p className="text-xs text-muted-foreground">
          {T.footerLeft}
        </p>
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

const inputClass = cn(
  "h-10 w-full rounded-md border border-input bg-card pl-9 pr-3 text-sm",
  "font-sans placeholder:text-muted-foreground/50 placeholder:font-mono placeholder:text-xs",
  "transition-colors",
  "focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring",
  "disabled:opacity-50",
);

function Field({
  label,
  icon: Icon,
  input,
}: {
  label: string;
  icon: typeof Mail;
  input: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted-foreground">
        {label}
      </span>
      <div className="relative">
        <Icon
          className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        {input}
      </div>
    </label>
  );
}

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
      <h1 className="font-display text-3xl font-semibold tracking-tight">
        {T.letterheadTitle}
      </h1>
      <div className="mx-auto mt-3 flex items-center justify-center gap-2">
        <span className="h-px w-12 bg-border" aria-hidden />
        <span className="text-xs text-muted-foreground">
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
