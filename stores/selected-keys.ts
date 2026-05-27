// stores/selected-keys.ts
//
// Tracks the user's multi-row selection in the object browser. Per
// CLAUDE.md task 14.4 the rules are:
//   * Set<string> of full R2 keys (or "prefix/" entries for folders) —
//     selections persist across infinite-query "Load more" pages so a user
//     drilling down a long folder doesn't lose what they've already checked.
//   * Selection MUST be cleared automatically when (bucket, prefix) changes,
//     because a key selected at "a/b/" is meaningless at "a/c/" and a delete
//     based on stale selection would target the wrong path. The page calls
//     `onPrefixChange({ bucket, prefix })` from a useEffect — the store
//     compares the incoming scope against what it last saw and only clears
//     if it actually moved.
//
// Security invariant (CLAUDE.md §2): nothing in this store is a credential
// or a token; the keys are pointers to objects the user already has access
// to via the server-side connection ULID. No persist middleware — selection
// is intentionally ephemeral (in-memory only).
//
// Why a Set (and not an array): adding/removing is O(1); .has() lets the
// table render selected state per-row without an Array.includes() linear
// scan on every render. Each mutation produces a NEW Set instance so
// shallow-equality consumers (Zustand subscribers, React re-renders) wake
// up correctly — mutating the existing Set in place would break that.

import { create } from "zustand";

interface SelectionScope {
  bucket: string;
  prefix: string;
}

interface SelectedKeysState {
  /** Currently-selected keys/prefixes. New Set on every mutation. */
  selectedKeys: Set<string>;
  /** The (bucket, prefix) the current selection belongs to. Null while
   *  the browser hasn't been opened yet. */
  scope: SelectionScope | null;

  /** Flip the selection state of one key. */
  toggle: (key: string) => void;
  /** Replace the entire selection. Pass [] to clear (equivalent to .clear()). */
  setSelection: (keys: string[]) => void;
  /** Clear the selection without touching `scope`. */
  clear: () => void;
  /**
   * Called by the browser page whenever the route's (bucket, prefix)
   * changes. If the scope is the same as the last one we saw, this is a
   * no-op (so we don't churn React state on every re-render). If the scope
   * moved — including across buckets or to/from root — selection is cleared
   * and the new scope recorded.
   */
  onPrefixChange: (next: SelectionScope) => void;
}

function scopeEquals(a: SelectionScope | null, b: SelectionScope): boolean {
  return a !== null && a.bucket === b.bucket && a.prefix === b.prefix;
}

export const useSelectedKeysStore = create<SelectedKeysState>()((set) => ({
  selectedKeys: new Set<string>(),
  scope: null,

  toggle: (key) =>
    set((state) => {
      const next = new Set(state.selectedKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { selectedKeys: next };
    }),

  setSelection: (keys) => set(() => ({ selectedKeys: new Set(keys) })),

  clear: () => set(() => ({ selectedKeys: new Set<string>() })),

  onPrefixChange: (next) =>
    set((state) => {
      if (scopeEquals(state.scope, next)) {
        // Same scope — preserve selection. Returning {} (no diff) avoids a
        // pointless re-render for every consumer.
        return {};
      }
      return {
        selectedKeys: new Set<string>(),
        scope: { bucket: next.bucket, prefix: next.prefix },
      };
    }),
}));

/** Convenience hook: subscribe to just the count, so a header banner doesn't
 *  re-render every time `selectedKeys` mutates internally (Set identity
 *  changes per mutation, but the count often doesn't change). */
export function useSelectedKeysCount(): number {
  return useSelectedKeysStore((s) => s.selectedKeys.size);
}
