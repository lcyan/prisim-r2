// tests/unit/stores/active-connection.test.ts
//
// Spec for the persisted active-connection Zustand store. Runs in plain
// Node — `createJSONStorage(() => localStorage)` returns undefined when
// localStorage isn't defined, which makes persist a no-op for these tests
// (and accurately mirrors what happens on the server during SSR).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  useActiveConnectionStore,
} from "@/stores/active-connection";

beforeEach(() => {
  // Reset every test back to "nothing picked" so cross-test pollution can't
  // accidentally make a later assertion succeed for the wrong reason. Reset
  // BOTH slots — adding only activeConnectionId would let a leftover
  // activeBucket from an earlier test seed the next one.
  useActiveConnectionStore.setState({
    activeConnectionId: null,
    activeBucket: null,
  });
});

afterEach(() => {
  useActiveConnectionStore.setState({
    activeConnectionId: null,
    activeBucket: null,
  });
});

describe("useActiveConnectionStore — connection slot", () => {
  it("starts with no active connection and no active bucket", () => {
    const state = useActiveConnectionStore.getState();
    expect(state.activeConnectionId).toBeNull();
    expect(state.activeBucket).toBeNull();
  });

  it("setActiveConnectionId stores a ULID", () => {
    const id = "01HZX0X0X0X0X0X0X0X0X0X0X0";
    useActiveConnectionStore.getState().setActiveConnectionId(id);
    expect(useActiveConnectionStore.getState().activeConnectionId).toBe(id);
  });

  it("setActiveConnectionId(null) clears the selection", () => {
    useActiveConnectionStore
      .getState()
      .setActiveConnectionId("01HZX0X0X0X0X0X0X0X0X0X0X0");
    useActiveConnectionStore.getState().setActiveConnectionId(null);
    expect(useActiveConnectionStore.getState().activeConnectionId).toBeNull();
  });

  it("clearActiveConnectionId is an alias for setting null (and also clears the bucket)", () => {
    useActiveConnectionStore.getState().setActiveConnectionId("anything");
    useActiveConnectionStore.getState().setActiveBucket("some-bucket");
    useActiveConnectionStore.getState().clearActiveConnectionId();
    const state = useActiveConnectionStore.getState();
    expect(state.activeConnectionId).toBeNull();
    expect(state.activeBucket).toBeNull();
  });

  it("namespaces its persisted storage key", () => {
    // Mostly a guard against accidentally moving the key to a generic name
    // that could clash with a different feature's persisted slice.
    expect(ACTIVE_CONNECTION_STORAGE_KEY).toBe("prisim-r2:active-connection");
  });

  it("only exposes the documented actions (no credential setters)", () => {
    // Security: this store must NEVER grow setters that accept access keys,
    // secrets, or tokens. The test pins the public surface so any drift
    // forces a code review.
    const state = useActiveConnectionStore.getState();
    const keys = Object.keys(state).sort();
    expect(keys).toEqual([
      "activeBucket",
      "activeConnectionId",
      "clearActiveConnectionId",
      "setActiveBucket",
      "setActiveConnectionId",
    ]);
  });
});

describe("useActiveConnectionStore — bucket slot", () => {
  it("setActiveBucket stores a name under the current connection", () => {
    const store = useActiveConnectionStore.getState();
    store.setActiveConnectionId("01HZX0X0X0X0X0X0X0X0X0X0X0");
    store.setActiveBucket("primary");
    expect(useActiveConnectionStore.getState().activeBucket).toBe("primary");
  });

  it("setActiveBucket(null) clears the selection", () => {
    const store = useActiveConnectionStore.getState();
    store.setActiveConnectionId("01HZX0X0X0X0X0X0X0X0X0X0X0");
    store.setActiveBucket("primary");
    store.setActiveBucket(null);
    expect(useActiveConnectionStore.getState().activeBucket).toBeNull();
  });

  it("switching to a DIFFERENT connection clears the bucket — different account same name is a different bucket", () => {
    // This is the central rule the store enforces on behalf of consumers,
    // so it's worth a dedicated test rather than relying on the trigger
    // logic to be re-derived at every callsite.
    const store = useActiveConnectionStore.getState();
    store.setActiveConnectionId("01HZX0X0X0X0X0X0X0X0X0X0X0");
    store.setActiveBucket("primary");
    store.setActiveConnectionId("01HZY1Y1Y1Y1Y1Y1Y1Y1Y1Y1Y1");
    const next = useActiveConnectionStore.getState();
    expect(next.activeConnectionId).toBe("01HZY1Y1Y1Y1Y1Y1Y1Y1Y1Y1Y1");
    expect(next.activeBucket).toBeNull();
  });

  it("re-selecting the SAME connection id keeps the bucket — toggling the switcher shouldn't wipe state", () => {
    const id = "01HZX0X0X0X0X0X0X0X0X0X0X0";
    const store = useActiveConnectionStore.getState();
    store.setActiveConnectionId(id);
    store.setActiveBucket("primary");
    // Mimics the user re-confirming the current connection in the picker.
    store.setActiveConnectionId(id);
    expect(useActiveConnectionStore.getState().activeBucket).toBe("primary");
  });

  it("setActiveConnectionId(null) also drops the bucket — no orphan bucket without a connection", () => {
    const store = useActiveConnectionStore.getState();
    store.setActiveConnectionId("01HZX0X0X0X0X0X0X0X0X0X0X0");
    store.setActiveBucket("primary");
    store.setActiveConnectionId(null);
    expect(useActiveConnectionStore.getState().activeBucket).toBeNull();
  });
});
