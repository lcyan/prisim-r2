"use client";

import type { ComponentProps, ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface IconProps {
  className?: string;
  strokeWidth?: number;
}

export const authInputBaseClass = cn(
  "w-full rounded-md border border-input bg-card font-sans text-sm",
  "placeholder:text-muted-foreground/50 placeholder:font-mono placeholder:text-xs placeholder:tracking-normal",
  "transition-colors",
  "focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring",
  "disabled:opacity-50",
);

interface AuthFieldProps {
  label: string;
  icon?: ComponentType<IconProps>;
  invalid?: boolean;
  inputProps?: ComponentProps<"input">;
  children?: ReactNode;
}

export function AuthField({
  label,
  icon: Icon,
  invalid,
  inputProps,
  children,
}: AuthFieldProps) {
  const { className, ...rest } = inputProps ?? {};
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted-foreground">
        {label}
      </span>
      <div className="relative">
        {Icon ? (
          <Icon
            className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
          />
        ) : null}
        {children ?? (
          <input
            {...rest}
            className={cn(
              authInputBaseClass,
              "h-10",
              Icon ? "pl-9 pr-3" : "px-3",
              invalid && "border-destructive/60",
              className,
            )}
          />
        )}
      </div>
    </label>
  );
}
