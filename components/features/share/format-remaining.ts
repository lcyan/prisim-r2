// components/features/share/format-remaining.ts
//
// Pure formatter for the Share dialog's expiry countdown. Kept in a .ts
// file (not .tsx) so the vitest config (jsx: preserve in tsconfig) can
// import and assert on it without spinning up a React renderer.

/**
 * Format a duration (ms) as `Nd HH:MM:SS` / `HH:MM:SS` / `MM:SS`. Zero
 * and negative durations collapse to `00:00` — the caller decides whether
 * to label that as "Expired" or just render the string.
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  if (hours > 0) return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return `${pad(mins)}:${pad(secs)}`;
}
