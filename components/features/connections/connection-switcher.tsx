"use client";

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Check,
  CircleHelp,
  Loader2,
  Plus,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Connection switcher + add form (skeleton).
 *
 *   ConnectionSwitcherMenu  → popover content listing connections, rendered
 *                              positioned absolutely by the parent. Parent
 *                              owns open state.
 *   AddConnectionDialog     → modal for adding a new R2 connection (name +
 *                              accountId + accessKeyId + secretAccessKey).
 *                              Includes inline "Test connection" affordance.
 *   ConnectionSwitcherShell → convenience wrapper that combines both with
 *                              click-outside handling. Use this in AppShell.
 *
 * No network calls here — the page wires onPick / onAdd to TanStack Query
 * mutations from hooks/use-connections.ts (see Task 10/11).
 */

export type ConnectionStatus = "ok" | "warn" | "error";

export interface Connection {
  id: string;
  name: string;
  accountIdMasked: string; // e.g. "8b21…f4c7"
  accessKeyMasked: string; // e.g. "abcd…wxyz"
  status: ConnectionStatus;
  lastUsedAt?: Date;
}

export interface NewConnectionInput {
  name: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/* ============================================================ */
/* Shell — combines menu + dialog, handles outside click.       */
/* ============================================================ */

interface ShellProps {
  /** the trigger button (typically the ConnectionPill from AppShell) */
  children: (props: {
    open: boolean;
    toggle: () => void;
    ref: React.RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
  connections: Connection[];
  activeId?: string;
  onPick: (id: string) => void;
  onAdd: (
    input: NewConnectionInput,
  ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  onManage?: () => void;
}

export function ConnectionSwitcherShell({
  children,
  connections,
  activeId,
  onPick,
  onAdd,
  onManage,
}: ShellProps) {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Outside click + Esc close
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t))
        return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <div className="relative">
        {children({
          open,
          toggle: () => setOpen((v) => !v),
          ref: triggerRef,
        })}
        {open ? (
          <div
            ref={menuRef}
            className="absolute top-[calc(100%+6px)] left-0 z-40 w-[320px]"
          >
            <ConnectionSwitcherMenu
              connections={connections}
              activeId={activeId}
              onPick={(id) => {
                onPick(id);
                setOpen(false);
              }}
              onAddClick={() => {
                setOpen(false);
                setDialogOpen(true);
              }}
              onManage={() => {
                setOpen(false);
                onManage?.();
              }}
            />
          </div>
        ) : null}
      </div>

      {dialogOpen ? (
        <AddConnectionDialog
          onClose={() => setDialogOpen(false)}
          onAdd={onAdd}
        />
      ) : null}
    </>
  );
}

/* ============================================================ */
/* Menu — list of connections + add CTA.                        */
/* ============================================================ */

interface MenuProps {
  connections: Connection[];
  activeId?: string;
  onPick: (id: string) => void;
  onAddClick: () => void;
  onManage?: () => void;
}

export function ConnectionSwitcherMenu({
  connections,
  activeId,
  onPick,
  onAddClick,
  onManage,
}: MenuProps) {
  return (
    <div
      role="menu"
      className="overflow-hidden rounded-lg border border-border bg-popover"
      style={{ boxShadow: "var(--shadow-lg)" }}
    >
      <div className="border-b border-border px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Connections
        </p>
      </div>

      <ul className="max-h-[280px] overflow-auto py-1">
        {connections.length === 0 ? (
          <li className="px-3 py-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              No connections yet
            </p>
          </li>
        ) : (
          connections.map((c) => {
            const isActive = c.id === activeId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onPick(c.id)}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                    "hover:bg-accent/60",
                    isActive && "bg-accent/40 signal-bar",
                  )}
                >
                  <StatusDot status={c.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {c.name}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {c.accountIdMasked}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {c.accessKeyMasked}
                      {c.lastUsedAt
                        ? ` · used ${relativeShort(c.lastUsedAt)}`
                        : " · never used"}
                    </p>
                  </div>
                  {isActive ? (
                    <Check
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                      strokeWidth={2.5}
                    />
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ul>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-secondary/30 px-2 py-1.5">
        <button
          type="button"
          onClick={onAddClick}
          className="inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="h-3 w-3" />
          Add connection
        </button>
        {onManage ? (
          <button
            type="button"
            onClick={onManage}
            className="inline-flex h-7 items-center gap-1.5 rounded px-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <SettingsIcon className="h-3 w-3" />
            Manage
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  const color =
    status === "ok"
      ? "bg-success"
      : status === "warn"
        ? "bg-warning"
        : "bg-destructive";
  return (
    <span className="relative h-1.5 w-1.5 shrink-0">
      {status === "ok" ? (
        <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40" />
      ) : null}
      <span
        className={cn("absolute inset-0 rounded-full", color)}
        aria-hidden
      />
    </span>
  );
}

/* ============================================================ */
/* Dialog — Add Connection (name + accountId + key + secret).   */
/* ============================================================ */

interface DialogProps {
  onClose: () => void;
  onAdd: ShellProps["onAdd"];
}

export function AddConnectionDialog({ onClose, onAdd }: DialogProps) {
  const [form, setForm] = useState<NewConnectionInput>({
    name: "",
    accountId: "",
    accessKeyId: "",
    secretAccessKey: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const headingId = useId();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function update<K extends keyof NewConnectionInput>(
    key: K,
    value: NewConnectionInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
    if (error) setError(null);
  }

  const valid =
    form.name.trim().length > 0 &&
    /^[a-f0-9]{32}$/.test(form.accountId.trim()) &&
    form.accessKeyId.trim().length >= 20 &&
    form.secretAccessKey.trim().length >= 40;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    const result = await onAdd({
      name: form.name.trim(),
      accountId: form.accountId.trim(),
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey.trim(),
    });
    setPending(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.error);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/20 backdrop-blur-[2px]"
      />

      <div
        className="relative w-full max-w-[460px] overflow-hidden rounded-xl border border-border bg-card"
        style={{ boxShadow: "var(--shadow-xl)" }}
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2
              id={headingId}
              className="font-display text-lg font-semibold tracking-tight"
            >
              Add R2 connection
            </h2>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Credentials encrypted with AES-GCM before storage
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 px-5 py-5"
          noValidate
        >
          <DialogField
            label="Name"
            hint="Any alias — shown in switcher."
            input={
              <input
                type="text"
                autoFocus
                required
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                disabled={pending}
                className={baseInput}
                placeholder="personal"
              />
            }
          />

          <DialogField
            label="Account ID"
            hint="32-char hex from Cloudflare dashboard URL."
            input={
              <input
                type="text"
                required
                spellCheck={false}
                autoComplete="off"
                value={form.accountId}
                onChange={(e) =>
                  update("accountId", e.target.value.toLowerCase())
                }
                disabled={pending}
                className={cn(baseInput, "font-mono text-xs tracking-wider")}
                placeholder="8b21a3f4c705e6d09b8214f6c7a9b3d2"
                maxLength={32}
              />
            }
          />

          <DialogField
            label="Access Key ID"
            input={
              <input
                type="text"
                required
                spellCheck={false}
                autoComplete="off"
                value={form.accessKeyId}
                onChange={(e) => update("accessKeyId", e.target.value)}
                disabled={pending}
                className={cn(baseInput, "font-mono text-xs")}
                placeholder="AKIA…"
              />
            }
          />

          <DialogField
            label="Secret Access Key"
            hint="Stored encrypted. Never visible after submit."
            input={
              <input
                type="password"
                required
                spellCheck={false}
                autoComplete="off"
                value={form.secretAccessKey}
                onChange={(e) => update("secretAccessKey", e.target.value)}
                disabled={pending}
                className={cn(baseInput, "font-mono text-xs")}
                placeholder="••••••••••••••••••••••••••••••••"
              />
            }
          />

          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                strokeWidth={2}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-destructive">
                  Couldn’t add connection
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-destructive/80">
                  {error}
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-1">
            <a
              href="https://developers.cloudflare.com/r2/api/s3/tokens/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            >
              <CircleHelp className="h-3 w-3" />
              How to create an R2 token
            </a>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="inline-flex h-9 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!valid || pending}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-opacity",
                  "hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {pending ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  "Test & save"
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

const baseInput = cn(
  "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm",
  "placeholder:text-muted-foreground/50 placeholder:font-mono placeholder:text-xs",
  "transition-colors",
  "focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring",
  "disabled:opacity-50",
);

function DialogField({
  label,
  hint,
  input,
}: {
  label: string;
  hint?: string;
  input: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </span>
        {hint ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground/70">
            {hint}
          </span>
        ) : null}
      </div>
      {input}
    </label>
  );
}

function relativeShort(date: Date): string {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return date.toISOString().slice(0, 10);
}
