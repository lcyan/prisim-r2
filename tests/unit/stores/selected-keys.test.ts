// tests/unit/stores/selected-keys.test.ts
//
// Spec for the multi-select Zustand store used by the object browser.
// In-memory only (no persist middleware), so resetting state between tests
// is just a `setState({...})` call.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useSelectedKeysStore } from "@/stores/selected-keys";

function reset() {
  useSelectedKeysStore.setState({
    selectedKeys: new Set<string>(),
    scope: null,
  });
}

beforeEach(reset);
afterEach(reset);

describe("toggle", () => {
  it("adds a key when not present and removes it when present", () => {
    const { toggle } = useSelectedKeysStore.getState();
    toggle("a");
    expect(useSelectedKeysStore.getState().selectedKeys.has("a")).toBe(true);
    toggle("a");
    expect(useSelectedKeysStore.getState().selectedKeys.has("a")).toBe(false);
  });

  it("produces a new Set instance on each mutation (so React re-renders)", () => {
    const before = useSelectedKeysStore.getState().selectedKeys;
    useSelectedKeysStore.getState().toggle("a");
    const after = useSelectedKeysStore.getState().selectedKeys;
    expect(after).not.toBe(before);
  });
});

describe("setSelection", () => {
  it("replaces the entire selection", () => {
    const { toggle, setSelection } = useSelectedKeysStore.getState();
    toggle("a");
    toggle("b");
    setSelection(["c", "d"]);
    const keys = Array.from(
      useSelectedKeysStore.getState().selectedKeys,
    ).sort();
    expect(keys).toEqual(["c", "d"]);
  });

  it("setSelection([]) clears the selection", () => {
    useSelectedKeysStore.getState().toggle("a");
    useSelectedKeysStore.getState().setSelection([]);
    expect(useSelectedKeysStore.getState().selectedKeys.size).toBe(0);
  });
});

describe("clear", () => {
  it("empties the selection without touching scope", () => {
    const { toggle, onPrefixChange, clear } = useSelectedKeysStore.getState();
    onPrefixChange({ bucket: "b1", prefix: "a/" });
    toggle("a/x");
    clear();
    const state = useSelectedKeysStore.getState();
    expect(state.selectedKeys.size).toBe(0);
    // Scope MUST survive — clearing is independent of navigation.
    expect(state.scope).toEqual({ bucket: "b1", prefix: "a/" });
  });
});

describe("onPrefixChange", () => {
  it("records the first scope and leaves an empty selection alone", () => {
    useSelectedKeysStore
      .getState()
      .onPrefixChange({ bucket: "b1", prefix: "" });
    const state = useSelectedKeysStore.getState();
    expect(state.scope).toEqual({ bucket: "b1", prefix: "" });
    expect(state.selectedKeys.size).toBe(0);
  });

  it("is a no-op when the scope is unchanged (preserves selection)", () => {
    const { toggle, onPrefixChange } = useSelectedKeysStore.getState();
    onPrefixChange({ bucket: "b1", prefix: "a/" });
    toggle("a/x");
    const before = useSelectedKeysStore.getState().selectedKeys;
    onPrefixChange({ bucket: "b1", prefix: "a/" });
    const after = useSelectedKeysStore.getState().selectedKeys;
    // Same reference — Zustand returned an empty diff so no re-render fires.
    expect(after).toBe(before);
    expect(after.has("a/x")).toBe(true);
  });

  it("clears selection when prefix changes within the same bucket", () => {
    const { toggle, onPrefixChange } = useSelectedKeysStore.getState();
    onPrefixChange({ bucket: "b1", prefix: "a/" });
    toggle("a/x");
    onPrefixChange({ bucket: "b1", prefix: "b/" });
    const state = useSelectedKeysStore.getState();
    expect(state.selectedKeys.size).toBe(0);
    expect(state.scope).toEqual({ bucket: "b1", prefix: "b/" });
  });

  it("clears selection when bucket changes", () => {
    const { toggle, onPrefixChange } = useSelectedKeysStore.getState();
    onPrefixChange({ bucket: "b1", prefix: "" });
    toggle("x");
    onPrefixChange({ bucket: "b2", prefix: "" });
    expect(useSelectedKeysStore.getState().selectedKeys.size).toBe(0);
  });

  it("clears selection on transition root → nested → root", () => {
    const { toggle, onPrefixChange } = useSelectedKeysStore.getState();
    onPrefixChange({ bucket: "b1", prefix: "" });
    toggle("file-at-root.txt");
    // Moving down clears.
    onPrefixChange({ bucket: "b1", prefix: "a/" });
    expect(useSelectedKeysStore.getState().selectedKeys.size).toBe(0);
    useSelectedKeysStore.getState().toggle("a/x");
    // Moving back up clears again.
    onPrefixChange({ bucket: "b1", prefix: "" });
    expect(useSelectedKeysStore.getState().selectedKeys.size).toBe(0);
  });
});
