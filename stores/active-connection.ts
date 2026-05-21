// stores/active-connection.ts
//
// Tracks which R2 connection — and within it, which bucket — the dashboard
// is currently scoped to. Both values are ULIDs/identifiers the server
// already knows; they are the only pieces of state that ever land in
// localStorage from this app.
//
// Security invariant (CLAUDE.md §2):
//   * NEVER store credentials, access keys, secrets, tokens, or any
//     decrypted material in this store. The IDs/bucket name are pointers
//     to server-side rows protected by the user's session; they are NOT
//     themselves bearer secrets.
//   * `partialize` is explicit (not the default) so that adding a new
//     transient piece of state (e.g. a "switching" boolean) to the slice
//     can't accidentally leak it through localStorage.
//
// Why one store and not two: the bucket choice is meaningless without a
// connection (the same bucket name can belong to different R2 accounts),
// so we co-locate them and clear `activeBucket` automatically when the
// connection changes. Splitting into two stores would let "user A switches
// connection but the bucket selector still shows the old bucket" slip
// through any time a consumer forgot to coordinate the two.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface ActiveConnectionState {
  /** ULID of the currently selected connection, or null if the user hasn't
   *  picked one yet (or just deleted the one that was active). */
  activeConnectionId: string | null;
  /** Name of the currently selected bucket under `activeConnectionId`, or
   *  null if no bucket has been picked yet. Cleared automatically when
   *  the connection changes — see `setActiveConnectionId`. */
  activeBucket: string | null;
  /** Pick a connection. If the new id differs from the current one we ALSO
   *  clear `activeBucket`, because the same bucket name on a different R2
   *  account is a different bucket. Passing the same id is a no-op for the
   *  bucket so toggling/re-selecting the active connection in the switcher
   *  doesn't wipe the user's current view. */
  setActiveConnectionId: (id: string | null) => void;
  /** Pick a bucket under the current connection. No-op semantics if the
   *  caller passes the same value. */
  setActiveBucket: (bucket: string | null) => void;
  /** Explicit clear. Use this after the active connection has been
   *  deleted — keeping a stale ID around would make the dashboard try
   *  to fetch buckets for a non-existent row. Also clears the bucket so
   *  callers don't need to remember the cascade. */
  clearActiveConnectionId: () => void;
}

/** localStorage key. Namespaced under the app's slug so multiple Prisim
 *  apps on the same host (preview deployments, e.g.) don't collide. */
export const ACTIVE_CONNECTION_STORAGE_KEY = "prisim-r2:active-connection";

export const useActiveConnectionStore = create<ActiveConnectionState>()(
  persist(
    (set) => ({
      activeConnectionId: null,
      activeBucket: null,
      setActiveConnectionId: (id) =>
        set((state) =>
          state.activeConnectionId === id
            ? { activeConnectionId: id }
            : { activeConnectionId: id, activeBucket: null },
        ),
      setActiveBucket: (bucket) => set({ activeBucket: bucket }),
      clearActiveConnectionId: () =>
        set({ activeConnectionId: null, activeBucket: null }),
    }),
    {
      name: ACTIVE_CONNECTION_STORAGE_KEY,
      // createJSONStorage lazily resolves localStorage so the store is safe
      // to import on the server (storage will be undefined there and persist
      // becomes a no-op until hydration on the client).
      storage: createJSONStorage(() => localStorage),
      // Explicit projection — see security note above.
      partialize: (state) => ({
        activeConnectionId: state.activeConnectionId,
        activeBucket: state.activeBucket,
      }),
      // Bump from 1 → 2 because the persisted shape grew a field. Without
      // a bump, a hydrated v1 blob would still load (zustand defaults
      // missing keys to undefined) but the migrate hook is the documented
      // path for future shape changes — establishing it now is cheap.
      version: 2,
      migrate: (persisted, version) => {
        if (version < 2 && persisted && typeof persisted === "object") {
          return { ...persisted, activeBucket: null } as ActiveConnectionState;
        }
        return persisted as ActiveConnectionState;
      },
    },
  ),
);
