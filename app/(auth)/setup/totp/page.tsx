// app/(auth)/setup/totp/page.tsx

"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

import { useAuthEnrollStore } from "@/stores/auth-enroll";
import { enrollComplete, ApiClientError } from "@/lib/api/client";
import { TotpField } from "@/components/features/auth/TotpField";
import { QrDisplay } from "@/components/features/auth/QrDisplay";
import { RecoveryCodeGrid } from "@/components/features/auth/RecoveryCodeGrid";
import { describeError } from "@/lib/i18n/error-messages";

export default function SetupTotpPage() {
  const router = useRouter();
  const draft = useAuthEnrollStore();

  const [step, setStep] = useState<"scan" | "saved">("scan");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [signInGrant, setSignInGrant] = useState<string | null>(null);
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const guardedRef = useRef(false);

  // No draft → bounce back to /login (refresh / direct hit)
  useEffect(() => {
    if (!draft.grant || !draft.qrSvg) {
      router.replace("/login");
    }
  }, [draft.grant, draft.qrSvg, router]);

  // beforeunload guard during step 2
  useEffect(() => {
    if (step !== "saved") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [step]);

  if (!draft.grant || !draft.qrSvg || !draft.email || !draft.secretBase32) {
    return null;
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError("auth.otp.invalid");
      return;
    }
    setPending(true);
    try {
      const result = await enrollComplete({
        email: draft.email!,
        grant: draft.grant!,
        code,
      });
      setRecoveryCodes(result.recoveryCodes);
      setSignInGrant(result.signInGrant);
      setStep("saved");
    } catch (err) {
      if (err instanceof ApiClientError) {
        // grant_expired AND invalid_code both mean the enrollment row was
        // consumed (see /enroll/complete atomic DELETE-RETURNING) — there is
        // no retry path against the dead grant. Clear the draft and bounce
        // back to /login so the user restarts from preflight.
        if (
          err.code === "auth.totp.grant_expired" ||
          err.code === "auth.totp.invalid_code"
        ) {
          draft.clear();
          alert(
            err.code === "auth.totp.invalid_code"
              ? "验证码错误,出于安全原因绑定已重置。请重新登录后重新扫码。"
              : "绑定已超时,请重新登录",
          );
          router.replace("/login");
          return;
        }
        setError(err.code);
      } else {
        setError("internal.unexpected");
      }
    } finally {
      setPending(false);
    }
  }

  async function finishAndSignIn() {
    if (!signInGrant || guardedRef.current) return;
    guardedRef.current = true;
    setPending(true);
    try {
      const res = await signIn("credentials", {
        email: draft.email,
        signInGrant,
        redirect: false,
      });
      if (!res || res.error) {
        alert("登录已失效,请重新登录");
        draft.clear();
        router.replace("/login");
        return;
      }
      draft.clear();
      router.replace("/");
    } finally {
      setPending(false);
      guardedRef.current = false;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold">绑定 Authenticator</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          首次登录需要绑定一次性密码 (TOTP) 以保护账号。
        </p>
      </header>

      {step === "scan" && (
        <form onSubmit={submitCode} className="flex flex-col gap-5">
          <QrDisplay svg={draft.qrSvg} secretBase32={draft.secretBase32} />
          <TotpField
            value={code}
            onChange={setCode}
            disabled={pending}
            error={error ? describeError(error) : null}
            maxLength={6}
            autoFocus
            label="6 位验证码"
          />
          <button
            type="submit"
            disabled={pending}
            className="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {pending ? "正在验证…" : "继续"}
          </button>
        </form>
      )}

      {step === "saved" && (
        <section className="flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-semibold">已绑定 ✓</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              请妥善保存以下恢复码,Authenticator 丢失时可用任一恢复码登录。
              <span className="text-destructive">该列表仅此一次显示。</span>
            </p>
          </div>
          <RecoveryCodeGrid codes={recoveryCodes} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmedSaved}
              onChange={(e) => setConfirmedSaved(e.target.checked)}
            />
            我已安全保存这些恢复码
          </label>
          <button
            type="button"
            disabled={!confirmedSaved || pending}
            onClick={finishAndSignIn}
            className="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {pending ? "正在登录…" : "完成并登录"}
          </button>
        </section>
      )}
    </main>
  );
}
