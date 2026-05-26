"use client";

import { forwardRef, useId } from "react";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string | null;
  label?: string;
  /** 6 位 OTP 或 8 位恢复码(8-10 字符含连字符) */
  maxLength?: number;
  autoFocus?: boolean;
}

export const TotpField = forwardRef<HTMLInputElement, Props>(function TotpField(
  { value, onChange, disabled, error, label = "验证码", maxLength = 10, autoFocus },
  ref,
) {
  const errorId = useId();
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        ref={ref}
        type="text"
        inputMode="text"
        autoComplete="one-time-code"
        maxLength={maxLength}
        disabled={disabled}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="6 位验证码 或 恢复码"
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "h-11 rounded-md border border-input bg-background px-3 text-base tracking-widest font-mono",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          error && "border-destructive focus:ring-destructive",
        )}
      />
      {error && (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </label>
  );
});
