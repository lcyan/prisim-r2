// stores/active-connection.ts
//
// Tracks which R2 connection the dashboard is currently scoped to. The ID
// here is the SAME ULID the server uses (connections.id); it is the only
// thing that ever lives in localStorage from this app.
//
// Security invariant (CLAUDE.md §2):
//   * NEVER store credentials, access keys, secrets, tokens, or any
//     decrypted material in this store. The ID is a pointer to a server-
//     side record protected by the user's session; it is NOT itself a
//     bearer secret.
//   * `partialize` is explicit (not the default) so that adding a new
//     transient piece of state (e.g. a "switching" boolean) to the slice
//     can't accidentally leak it through localStorage.
//
// Why a Zustand store and not React Context: the active connection is
// read from many distant parts of the tree (sidebar, presign hook,
// object table, share dialogs) — context would force every consumer
// under a single Provider and trigger broad re-renders on change.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface ActiveConnectionState {
  /** ULID of the currently selected connection, or null if the user hasn't
   *  picked one yet (or just deleted the one that was active). */
  activeConnectionId: string | null;
  /** Pick a connection. Pass null to clear without forgetting the action
   *  semantics — `clearActiveConnectionId` exists for the same reason but
   *  is more explicit at call sites. */
  setActiveConnectionId: (id: string | null) => void;
  /** Explicit clear. Use this after the active connection has been
   *  deleted — keeping a stale ID around would make the dashboard try
   *  to fetch buckets for a non-existent row. */
  clearActiveConnectionId: () => void;
}

/** localStorage key. Namespaced under the app's slug so multiple Prisim
 *  apps on the same host (preview deployments, e.g.) don't collide. */
export const ACTIVE_CONNECTION_STORAGE_KEY = "prisim-r2:active-connection";

export const useActiveConnectionStore = create<ActiveConnectionState>()(
  persist(
    (set) => ({
      activeConnectionId: null,
      setActiveConnectionId: (id) => set({ activeConnectionId: id }),
      clearActiveConnectionId: () => set({ activeConnectionId: null }),
    }),
    {
      name: ACTIVE_CONNECTION_STORAGE_KEY,
      // createJSONStorage lazily resolves localStorage so the store is safe
      // to import on the server (storage will be undefined there and persist
      // becomes a no-op until hydration on the client).
      storage: createJSONStorage(() => localStorage),
      // Explicit projection — see security note above.
      partialize: (state) => ({ activeConnectionId: state.activeConnectionId }),
      version: 1,
    },
  ),
);
