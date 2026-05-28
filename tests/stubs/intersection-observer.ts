// tests/stubs/intersection-observer.ts
//
// Vitest setup file. jsdom does not provide IntersectionObserver, so we
// install a minimal shim into globalThis. Component tests can grab the
// most-recent observer instance via `lastObserver()` and fire a fake
// intersection by calling `lastObserver().trigger(true)`.
//
// The stub deliberately implements only what AutoLoadSentinel needs:
// the constructor, `observe` / `unobserve` / `disconnect` as no-ops, and
// the synchronous `trigger()` test affordance. No element tracking, no
// rootMargin / threshold semantics — those aren't needed for the
// "sentinel enters viewport" contract.

interface ObserverEntry {
  isIntersecting: boolean;
}

interface FakeObserver {
  callback: (entries: ObserverEntry[]) => void;
  observe: (el: Element) => void;
  unobserve: (el: Element) => void;
  disconnect: () => void;
  trigger: (isIntersecting: boolean) => void;
}

const observers: FakeObserver[] = [];

class FakeIntersectionObserver implements FakeObserver {
  public callback: (entries: ObserverEntry[]) => void;
  constructor(cb: (entries: ObserverEntry[]) => void) {
    this.callback = cb;
    observers.push(this);
  }
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
  trigger = (isIntersecting: boolean): void => {
    this.callback([{ isIntersecting }]);
  };
}

(
  globalThis as unknown as {
    IntersectionObserver: typeof FakeIntersectionObserver;
  }
).IntersectionObserver = FakeIntersectionObserver;

/** Most recently constructed observer; throws if no observer exists yet. */
export function lastObserver(): FakeObserver {
  const last = observers[observers.length - 1];
  if (!last) throw new Error("No IntersectionObserver instances yet");
  return last;
}

/** Clear the observer registry between tests. Call from `beforeEach`. */
export function resetObservers(): void {
  observers.length = 0;
}
