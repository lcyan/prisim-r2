import type { SVGProps } from "react";

/**
 * Prisim R2 三棱镜品牌标识。
 *
 * `variant="square"`:带圆角蓝色渐变底,白色棱镜,与 favicon 完全一致。
 * `variant="flat"`:透明底,棱镜用 currentColor,适合在已有底色的容器里嵌入。
 */
export interface PrismMarkProps extends Omit<SVGProps<SVGSVGElement>, "fill"> {
  size?: number;
  variant?: "square" | "flat";
}

export function PrismMark({
  size = 28,
  variant = "square",
  className,
  ...rest
}: PrismMarkProps) {
  if (variant === "flat") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className={className}
        {...rest}
      >
        <path d="M11 6.5 L22.2 24 L3.8 24 Z" fill="currentColor" />
        <path
          d="M21 13.4 L29 10.4"
          stroke="#1677FF"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <path
          d="M21 17 L29 17"
          stroke="#FF6A00"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <path
          d="M21 20.6 L29 23.6"
          stroke="#00B96B"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <rect width="32" height="32" rx="7" fill="url(#prisim-mark-bg)" />
      <path d="M11 6.5 L22.2 24 L3.8 24 Z" fill="#FFFFFF" />
      <path
        d="M21 13.4 L29 10.4"
        stroke="#FFFFFF"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M21 17 L29 17"
        stroke="#FFB061"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M21 20.6 L29 23.6"
        stroke="#85F4C2"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient
          id="prisim-mark-bg"
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1F86FF" />
          <stop offset="1" stopColor="#0E5FD8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export interface LogoProps {
  size?: number;
  variant?: PrismMarkProps["variant"];
  showSub?: boolean;
  className?: string;
}

/**
 * 完整 Logo:三棱镜标识 + "Prisim R2" 字标(R 后面跟上标 2,呼应 R²)。
 * showSub=true 时在副标位置展示 "Cloudflare R2 Console"。
 */
export function Logo({
  size = 32,
  variant = "square",
  showSub = false,
  className,
}: LogoProps) {
  return (
    <div
      className={["flex items-center gap-2.5", className]
        .filter(Boolean)
        .join(" ")}
    >
      <PrismMark size={size} variant={variant} />
      <div className="flex min-w-0 flex-col leading-none">
        <span className="font-semibold tracking-tight text-foreground">
          Prisim
          <span className="ml-1 text-primary">
            R<sup className="text-[0.65em]">2</sup>
          </span>
        </span>
        {showSub ? (
          <span className="mt-1 text-[11px] text-muted-foreground">
            Cloudflare R2 Console
          </span>
        ) : null}
      </div>
    </div>
  );
}
