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
  // Reset every test back to "no connection picked" so cross-test pollution
  // can't accidentally make a later assertion succeed for the wrong reason.
  useActiveConnectionStore.setState({ activeConnectionId: null });
});

afterEach(() => {
  useActiveConnectionStore.setState({ activeConnectionId: null });
});

describe("useActiveConnectionStore", () => {
  it("starts with no active connection", () => {
    expect(useActiveConnectionStore.getState().activeConnectionId).toBeNull();
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

  it("clearActiveConnectionId is an alias for setting null", () => {
    useActiveConnectionStore.getState().setActiveConnectionId("anything");
    useActiveConnectionStore.getState().clearActiveConnectionId();
    expect(useActiveConnectionStore.getState().activeConnectionId).toBeNull();
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
      "activeConnectionId",
      "clearActiveConnectionId",
      "setActiveConnectionId",
    ]);
  });
});
