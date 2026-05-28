"use client";

import { forwardRef, useId } from "react";
import { cn } from "@/lib/utils";
import { authInputBaseClass } from "./AuthField";

interface Props {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string | null;
  label?: string;
  /** Form input name so submit-time FormData can read the raw DOM value
   *  even when a password manager autofills without firing React onChange. */
  name?: string;
  /** 6 位 OTP 或 8 位恢复码(8-10 字符含连字符) */
  maxLength?: number;
  autoFocus?: boolean;
}

export const TotpField = forwardRef<HTMLInputElement, Props>(function TotpField(
  {
    value,
    onChange,
    disabled,
    readOnly,
    error,
    label = "验证码",
    name,
    maxLength = 10,
    autoFocus,
  },
  ref,
) {
  const errorId = useId();
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted-foreground">
        {label}
      </span>
      <input
        ref={ref}
        type="text"
        name={name}
        inputMode="text"
        autoComplete="one-time-code"
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="6 位验证码 或 恢复码"
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          authInputBaseClass,
          "h-11 px-3 text-base font-mono tracking-widest",
          error && "border-destructive focus:ring-destructive",
        )}
      />
      {error && (
        <span
          id={errorId}
          role="alert"
          className="mt-1 block text-xs text-destructive"
        >
          {error}
        </span>
      )}
    </label>
  );
});
