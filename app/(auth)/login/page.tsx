"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { AlertTriangle, ArrowRight, Lock, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Login page — single-user app. No registration UI by design (admin is seeded
 * via scripts/seed-admin.ts per CLAUDE.md). No password reset in V1.
 *
 * Aesthetic: editorial-spec-sheet. Letterhead at top, centered form, technical
 * footer with build metadata. Amber signal line spans the full top edge.
 */

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
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (!res || res.error) {
        // next-auth v5 buckets all Credentials failures into "CredentialsSignin"
        // — do not differentiate "user not found" vs "wrong password" client-side.
        setError("auth.invalid_credentials");
        return;
      }
      router.replace(callbackUrl);
      router.refresh();
    } catch {
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
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            R2 · edge console
          </span>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          v1.0 · build local
        </p>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[360px]">
          <Letterhead />

          <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
            <Field
              label="Email"
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
                  placeholder="me@example.com"
                />
              }
            />

            <Field
              label="Password"
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
              {pending ? "Authenticating…" : "Sign in"}
              {!pending ? (
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              ) : null}
            </button>
          </form>

          <p className="mt-8 text-center font-mono text-[10px] leading-relaxed text-muted-foreground">
            Single-user instance. Add accounts via{" "}
            <code className="rounded bg-secondary px-1 py-0.5">
              scripts/seed-admin.ts
            </code>
            .
          </p>
        </div>
      </main>

      <footer className="flex items-center justify-between border-t border-border px-6 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          AES-GCM at rest · presigned direct I/O
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          cloudflare pages
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
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
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
        <p className="text-xs font-medium text-destructive">Sign-in failed</p>
        <p className="mt-0.5 font-mono text-[10px] text-destructive/80">
          {code}
        </p>
      </div>
    </div>
  );
}

function Letterhead() {
  return (
    <div className="text-center">
      <h1 className="font-display text-3xl font-semibold tracking-tight">
        Sign in
      </h1>
      <div className="mx-auto mt-3 flex items-center justify-center gap-2">
        <span className="h-px w-12 bg-border" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          encrypted
        </span>
        <span className="h-px w-12 bg-border" aria-hidden />
      </div>
    </div>
  );
}

function SignalLine() {
  return <div className="h-[2px] w-full bg-primary" aria-hidden />;
}
