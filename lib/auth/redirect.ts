const DEFAULT_POST_LOGIN_ROUTE = "/dashboard";
const LOCAL_URL_BASE = "http://local.invalid";

export function pickPostLoginRoute(
  callbackUrl?: string | null,
  opts: { origin?: string; fallback?: string } = {},
): string {
  const fallback = opts.fallback ?? DEFAULT_POST_LOGIN_ROUTE;
  if (!callbackUrl) return fallback;

  const target = toLocalPath(callbackUrl, opts.origin);
  if (!target) return fallback;
  return isAuthPath(target) ? fallback : target;
}

function toLocalPath(callbackUrl: string, origin?: string): string | null {
  if (callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")) {
    try {
      const url = new URL(callbackUrl, LOCAL_URL_BASE);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }

  if (!origin) return null;
  try {
    const url = new URL(callbackUrl);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function isAuthPath(path: string): boolean {
  const pathname = new URL(path, LOCAL_URL_BASE).pathname;
  return (
    pathname === "/login" ||
    pathname === "/setup/totp" ||
    pathname.startsWith("/api/auth")
  );
}
