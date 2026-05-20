"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Database,
  FileClock,
  Link2,
  LogOut,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type Connection,
  ConnectionSwitcherShell,
  type NewConnectionInput,
} from "@/components/features/connections/connection-switcher";

/**
 * AppShell — top bar + left sidebar + main content.
 * The top bar carries: brand mark, connection switcher, user menu.
 * The sidebar carries: primary nav with a 2px amber accent bar on the active item.
 *
 * Pure presentational skeleton — no data fetching. Wire to TanStack Query hooks
 * (use-connections, use-buckets) and Zustand activeConnection store at the page level.
 */

export type { Connection } from "@/components/features/connections/connection-switcher";

export interface AppShellUser {
  email: string;
}

interface AppShellProps {
  children: ReactNode;
  connections?: Connection[];
  activeConnectionId?: string;
  user?: AppShellUser;
  activeNav?: NavId;
  onNavigate?: (id: NavId) => void;
  onPickConnection?: (id: string) => void;
  onAddConnection?: (
    input: NewConnectionInput,
  ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  onManageConnections?: () => void;
  onSignOut?: () => void;
}

type NavId = "buckets" | "shares" | "audit" | "settings";

const NAV_ITEMS: Array<{
  id: NavId;
  label: string;
  icon: typeof Database;
  hint?: string;
}> = [
  { id: "buckets", label: "Buckets", icon: Database, hint: "Browse" },
  { id: "shares", label: "Shares", icon: Link2, hint: "Signed URLs" },
  { id: "audit", label: "Audit", icon: FileClock, hint: "Trail" },
  { id: "settings", label: "Settings", icon: Settings },
];

export function AppShell({
  children,
  connections = [],
  activeConnectionId,
  user,
  activeNav = "buckets",
  onNavigate,
  onPickConnection,
  onAddConnection,
  onManageConnections,
  onSignOut,
}: AppShellProps) {
  const activeConn =
    connections.find((c) => c.id === activeConnectionId) ??
    ({
      id: "—",
      name: "No connection",
      accountIdMasked: "—",
      accessKeyMasked: "—",
      status: "warn",
    } satisfies Connection);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        conn={activeConn}
        connections={connections}
        activeConnectionId={activeConnectionId}
        user={user}
        onPickConnection={onPickConnection}
        onAddConnection={onAddConnection}
        onManageConnections={onManageConnections}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          activeNav={activeNav}
          onNavigate={onNavigate}
          conn={activeConn}
          onSignOut={onSignOut}
        />
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function TopBar({
  conn,
  connections,
  activeConnectionId,
  user,
  onPickConnection,
  onAddConnection,
  onManageConnections,
}: {
  conn: Connection;
  connections: Connection[];
  activeConnectionId?: string;
  user?: AppShellUser;
  onPickConnection?: (id: string) => void;
  onAddConnection?: AppShellProps["onAddConnection"];
  onManageConnections?: () => void;
}) {
  // Stub onAdd if not provided so the dialog still works in demos.
  const handleAdd: NonNullable<AppShellProps["onAddConnection"]> =
    onAddConnection ??
    (async () => ({ ok: false, error: "onAddConnection not wired" }));

  return (
    <header
      className="flex shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur"
      style={{ height: "var(--topbar-h)" }}
    >
      <div className="flex items-center gap-5">
        <Link href="/" className="flex items-baseline gap-1.5">
          <span className="font-display text-xl font-semibold tracking-tight">
            Prisim
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            R2
          </span>
        </Link>

        <ConnectionSwitcherShell
          connections={connections}
          activeId={activeConnectionId}
          onPick={(id) => onPickConnection?.(id)}
          onAdd={handleAdd}
          onManage={onManageConnections}
        >
          {({ open, toggle, ref }) => (
            <ConnectionPill
              conn={conn}
              open={open}
              onClick={toggle}
              triggerRef={ref}
            />
          )}
        </ConnectionSwitcherShell>
      </div>

      <div className="flex items-center gap-3">
        {user ? (
          <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
            {user.email}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="User menu"
          className="grid h-7 w-7 place-items-center rounded-full bg-secondary font-display text-xs font-semibold text-secondary-foreground transition-opacity hover:opacity-80"
        >
          {user?.email?.[0]?.toUpperCase() ?? "?"}
        </button>
      </div>
    </header>
  );
}

function ConnectionPill({
  conn,
  open,
  onClick,
  triggerRef,
}: {
  conn: Connection;
  open: boolean;
  onClick: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const statusColor: Record<Connection["status"], string> = {
    ok: "bg-success",
    warn: "bg-warning",
    error: "bg-destructive",
  };
  const statusLabel: Record<Connection["status"], string> = {
    ok: "OK",
    warn: "IDLE",
    error: "ERROR",
  };
  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={onClick}
      aria-haspopup="menu"
      aria-expanded={open}
      className={cn(
        "group inline-flex h-8 items-center gap-2.5 rounded-md border bg-card px-2.5 text-sm transition-colors",
        open
          ? "border-foreground/30"
          : "border-border hover:border-foreground/30",
      )}
    >
      <span className="relative h-1.5 w-1.5">
        {conn.status === "ok" ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40" />
        ) : null}
        <span
          className={cn(
            "absolute inset-0 rounded-full",
            statusColor[conn.status],
          )}
          aria-hidden
        />
      </span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {statusLabel[conn.status]}
      </span>
      <span className="font-medium">{conn.name}</span>
      {conn.accountIdMasked && conn.accountIdMasked !== "—" ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {conn.accountIdMasked}
        </span>
      ) : null}
      <ChevronDown
        className={cn(
          "h-3 w-3 text-muted-foreground transition-transform",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

/* ──────────────────────────────────────────────────────────── */

function Sidebar({
  activeNav,
  onNavigate,
  conn,
  onSignOut,
}: {
  activeNav: NavId;
  onNavigate?: (id: NavId) => void;
  conn: Connection;
  onSignOut?: () => void;
}) {
  return (
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-background"
      style={{ width: "var(--sidebar-w)" }}
    >
      <div className="px-3 pt-4 pb-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Workspace
        </p>
      </div>

      <nav className="flex flex-col gap-px px-2">
        {NAV_ITEMS.map((item) => {
          const isActive = activeNav === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate?.(item.id)}
              data-active={isActive}
              className={cn(
                "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                isActive
                  ? "bg-accent font-medium text-foreground signal-bar"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={1.75} />
              <span className="flex-1 text-left">{item.label}</span>
              {item.hint ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  {item.hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border p-3">
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Active
        </p>
        <div className="mb-3 flex items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              conn.status === "ok" && "bg-success",
              conn.status === "warn" && "bg-warning",
              conn.status === "error" && "bg-destructive",
            )}
            aria-hidden
          />
          <span className="truncate text-xs font-medium text-foreground">
            {conn.name}
          </span>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <LogOut className="h-3 w-3" />
          Sign out
        </button>
      </div>
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Demo wrapper — delete when wiring into real pages.          */

export function AppShellDemo({ children }: { children: ReactNode }) {
  const [nav, setNav] = useState<NavId>("buckets");
  const [activeId, setActiveId] = useState("conn_01J");
  const [conns, setConns] = useState<Connection[]>(() => [
    {
      id: "conn_01J",
      name: "personal",
      accountIdMasked: "8b21…f4c7",
      accessKeyMasked: "AKIA…WXYZ",
      status: "ok",
      lastUsedAt: new Date(Date.now() - 4 * 60_000),
    },
    {
      id: "conn_02J",
      name: "side-project",
      accountIdMasked: "f0e1…2a9b",
      accessKeyMasked: "BKIB…PQRS",
      status: "warn",
    },
  ]);

  return (
    <AppShell
      connections={conns}
      activeConnectionId={activeId}
      user={{ email: "me@example.com" }}
      activeNav={nav}
      onNavigate={setNav}
      onPickConnection={setActiveId}
      onAddConnection={async (input) => {
        const id = `conn_${Math.random().toString(36).slice(2, 6)}`;
        setConns((cs) => [
          ...cs,
          {
            id,
            name: input.name,
            accountIdMasked:
              input.accountId.slice(0, 4) + "…" + input.accountId.slice(-4),
            accessKeyMasked:
              input.accessKeyId.slice(0, 4) + "…" + input.accessKeyId.slice(-4),
            status: "ok",
          },
        ]);
        setActiveId(id);
        return { ok: true, id };
      }}
      onManageConnections={() => setNav("settings")}
    >
      {children}
    </AppShell>
  );
}
