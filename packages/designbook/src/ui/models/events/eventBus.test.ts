/**
 * The shared `/api/events` bus (connection-starvation fix). Pins the load-
 * bearing contract: ONE EventSource per document regardless of how many
 * features subscribe, refcounted open/close with a grace window, named-event
 * routing, connection-status fan-out, and handler survival across reconnects.
 *
 * The node test env has no `EventSource`, so a fake is injected via the bus's
 * test seam — which also proves the SSR/test-safety requirement (nothing is
 * constructed at import; the factory is the only construction path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetEventBusForTests,
  setEventSourceFactoryForTests,
  setVisibilityDocumentForTests,
  subscribeApiEvents,
  subscribeConnectionStatus,
} from "./eventBus";

// A hair over the 5s grace window used by the bus.
const CLOSE_MS_PLUS = 5_100;
// A hair over the 15s hidden-tab grace window.
const HIDDEN_MS_PLUS = 15_100;

type Listener = (event: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: Listener): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  // --- test helpers ---
  emit(name: string, data?: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data });
  }
  fireOpen(): void {
    this.readyState = 1;
    this.emit("open");
  }
  fireError(): void {
    this.emit("error");
  }
}

const live = () => FakeEventSource.instances.filter((es) => !es.closed);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  setEventSourceFactoryForTests(
    (url) => new FakeEventSource(url) as unknown as EventSource,
  );
});

afterEach(() => {
  resetEventBusForTests();
  setEventSourceFactoryForTests(undefined);
  vi.useRealTimers();
});

describe("subscribeApiEvents", () => {
  it("opens exactly one EventSource for many subscribers/names", () => {
    const unsubA = subscribeApiEvents("state", () => {});
    const unsubB = subscribeApiEvents("pi-event", () => {});
    const unsubC = subscribeApiEvents("state", () => {});

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toContain("/api/events");

    unsubA();
    unsubB();
    unsubC();
  });

  it("routes a named event only to its handlers, passing the raw event", () => {
    const stateSeen: string[] = [];
    const piSeen: string[] = [];
    subscribeApiEvents("state", (event) => stateSeen.push(event.data as string));
    subscribeApiEvents("pi-event", (event) => piSeen.push(event.data as string));

    const es = FakeEventSource.instances[0]!;
    es.emit("state", '{"a":1}');
    es.emit("pi-event", '{"b":2}');
    es.emit("branch-status", '{"c":3}'); // no subscriber — dropped

    expect(stateSeen).toEqual(['{"a":1}']);
    expect(piSeen).toEqual(['{"b":2}']);
  });

  it("attaches a native listener for a name subscribed AFTER the stream opened", () => {
    subscribeApiEvents("state", () => {});
    const late: string[] = [];
    subscribeApiEvents("variations-event", (event) =>
      late.push(event.data as string),
    );

    FakeEventSource.instances[0]!.emit("variations-event", "hi");
    expect(late).toEqual(["hi"]);
  });

  it("isolates a throwing handler from the others", () => {
    const seen: string[] = [];
    subscribeApiEvents("state", () => {
      throw new Error("boom");
    });
    subscribeApiEvents("state", (event) => seen.push(event.data as string));

    FakeEventSource.instances[0]!.emit("state", "ok");
    expect(seen).toEqual(["ok"]);
  });
});

describe("refcounted lifecycle", () => {
  it("closes only after the LAST unsubscribe, and only past the grace delay", () => {
    const unsubA = subscribeApiEvents("state", () => {});
    const unsubB = subscribeApiEvents("pi-event", () => {});
    expect(live()).toHaveLength(1);

    unsubA();
    vi.advanceTimersByTime(CLOSE_MS_PLUS); // one subscriber left → stays open
    expect(live()).toHaveLength(1);

    unsubB(); // last out → schedule close
    expect(live()).toHaveLength(1); // still open during the grace window
    vi.advanceTimersByTime(CLOSE_MS_PLUS);
    expect(live()).toHaveLength(0);
  });

  it("a resubscribe within the grace window reuses the SAME connection", () => {
    const unsub = subscribeApiEvents("state", () => {});
    unsub(); // schedule close

    vi.advanceTimersByTime(1_000); // within grace
    const unsub2 = subscribeApiEvents("pi-event", () => {});
    vi.advanceTimersByTime(CLOSE_MS_PLUS);

    // No second ES was constructed, and the first was never closed.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(live()).toHaveLength(1);
    unsub2();
  });

  it("reopens a fresh connection after a full close", () => {
    subscribeApiEvents("state", () => {})();
    vi.advanceTimersByTime(CLOSE_MS_PLUS);
    expect(live()).toHaveLength(0);

    const unsub = subscribeApiEvents("state", () => {});
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(live()).toHaveLength(1);
    unsub();
  });
});

describe("reconnect survival", () => {
  it("keeps the same ES and its handlers across an error/reconnect", () => {
    const seen: string[] = [];
    subscribeApiEvents("state", (event) => seen.push(event.data as string));
    const es = FakeEventSource.instances[0]!;

    es.fireError(); // transient drop — EventSource reconnects internally
    expect(live()).toHaveLength(1); // we do NOT tear it down
    es.emit("state", "after-reconnect");

    expect(seen).toEqual(["after-reconnect"]);
  });
});

describe("hidden-tab lifecycle", () => {
  /** Minimal document fake driving the bus's visibilitychange hook. */
  function fakeDocument() {
    const listeners = new Set<() => void>();
    const doc = {
      hidden: false,
      addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) =>
        listeners.delete(fn),
      setHidden(hidden: boolean) {
        doc.hidden = hidden;
        for (const fn of [...listeners]) fn();
      },
    };
    return doc;
  }

  it("releases the stream after the tab stays hidden past the grace, keeping subscriptions", () => {
    const doc = fakeDocument();
    setVisibilityDocumentForTests(doc);
    const seen: string[] = [];
    subscribeApiEvents("state", (event) => seen.push(event.data as string));
    expect(live()).toHaveLength(1);

    doc.setHidden(true);
    vi.advanceTimersByTime(HIDDEN_MS_PLUS);
    expect(live()).toHaveLength(0); // pool slot freed

    // Refocus → a FRESH connection; the server's state replay lands on the
    // SAME still-registered handler.
    doc.setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(live()).toHaveLength(1);
    FakeEventSource.instances[1]!.emit("state", "replayed");
    expect(seen).toEqual(["replayed"]);
  });

  it("a quick tab-flip (hidden < grace) never touches the connection", () => {
    const doc = fakeDocument();
    setVisibilityDocumentForTests(doc);
    subscribeApiEvents("state", () => {});

    doc.setHidden(true);
    vi.advanceTimersByTime(5_000); // within the hidden grace
    doc.setHidden(false);
    vi.advanceTimersByTime(HIDDEN_MS_PLUS);

    expect(FakeEventSource.instances).toHaveLength(1); // same ES throughout
    expect(live()).toHaveLength(1);
  });

  it("a subscriber arriving while suspended waits for visibility to open", () => {
    const doc = fakeDocument();
    setVisibilityDocumentForTests(doc);
    subscribeApiEvents("state", () => {});
    doc.setHidden(true);
    vi.advanceTimersByTime(HIDDEN_MS_PLUS);
    expect(live()).toHaveLength(0);

    subscribeApiEvents("pi-event", () => {}); // hidden tab — must NOT reopen
    expect(live()).toHaveLength(0);

    doc.setHidden(false);
    expect(live()).toHaveLength(1);
  });

  it("a tab hidden from birth arms the release timer for its own stream", () => {
    const doc = fakeDocument();
    doc.hidden = true;
    setVisibilityDocumentForTests(doc);
    subscribeApiEvents("state", () => {});
    expect(live()).toHaveLength(1); // opens (nothing suspended yet)

    vi.advanceTimersByTime(HIDDEN_MS_PLUS);
    expect(live()).toHaveLength(0); // released without a visibilitychange
  });

  it("suspend surfaces 'error' to the status indicator; reopen surfaces 'open'", () => {
    const doc = fakeDocument();
    setVisibilityDocumentForTests(doc);
    const seen: string[] = [];
    subscribeConnectionStatus((status) => seen.push(status));
    FakeEventSource.instances[0]!.fireOpen();

    doc.setHidden(true);
    vi.advanceTimersByTime(HIDDEN_MS_PLUS);
    doc.setHidden(false);
    FakeEventSource.instances[1]!.fireOpen();

    expect(seen).toEqual(["open", "error", "open"]);
  });
});

describe("subscribeConnectionStatus", () => {
  it("fans out open/error to the chat indicator", () => {
    const seen: string[] = [];
    subscribeConnectionStatus((status) => seen.push(status));
    const es = FakeEventSource.instances[0]!;

    es.fireOpen();
    es.fireError();
    expect(seen).toEqual(["open", "error"]);
  });

  it("surfaces the current state immediately to a late status subscriber", () => {
    subscribeApiEvents("state", () => {});
    FakeEventSource.instances[0]!.fireOpen(); // stream already open

    const seen: string[] = [];
    subscribeConnectionStatus((status) => seen.push(status));
    expect(seen).toEqual(["open"]);
  });

  it("counts toward the refcount (holds the stream open on its own)", () => {
    const unsub = subscribeConnectionStatus(() => {});
    expect(live()).toHaveLength(1);
    unsub();
    vi.advanceTimersByTime(CLOSE_MS_PLUS);
    expect(live()).toHaveLength(0);
  });
});
