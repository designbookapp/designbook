/**
 * Live variations state + actions (design-variations spec, DECIDED).
 *
 * Composition-root provider (the `useChanges`/`useWorktrees` altitude): one
 * GET /api/variations on mount (reload reconstruction from the durable
 * index), one EventSource subscription folding `variations-event`s through
 * the pure model, and thin action wrappers over the write endpoints. The
 * Generate action POSTs DIRECTLY (D1 — no chat draft; the button is the
 * consent gate; writes are server-confined to `.designbook/variations/`).
 *
 * Landings/updates also ping the file-write bus so the Changes tab refreshes
 * immediately (ephemeral sessions' pi-events are never broadcast, so the
 * `agent_end` refresh path doesn't fire for them).
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { apiUrl } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";
import {
  applyVariationsEvent,
  setsFromStatus,
  type StatusPayload,
  type VariationsEvent,
  type VariationsState,
} from "./variationsModel";

type ActionResult = { error?: string };

type VariationsFocus = { base: string; slug: string } | undefined;

type VariationsApi = {
  /** Pending sets keyed by base entry id. */
  sets: VariationsState;
  /** The focus-cycler target (single layout renders this variant in place). */
  focus: VariationsFocus;
  setFocus: (focus: VariationsFocus) => void;
  generate: (params: {
    baseEntryId: string;
    baseSourcePath: string;
    count: number;
    direction?: string;
    context?: string;
  }) => Promise<ActionResult>;
  iterate: (params: {
    base: string;
    slug: string;
    note: string;
  }) => Promise<ActionResult>;
  retry: (params: { base: string; slug: string }) => Promise<ActionResult>;
  resolve: (params: {
    base: string;
    action: "keep" | "keepAs" | "discard" | "abandon";
    slug?: string;
    newName?: string;
  }) => Promise<ActionResult>;
};

const VariationsContext = createContext<VariationsApi | undefined>(undefined);

async function post(path: string, body: unknown): Promise<ActionResult> {
  try {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      return { error: payload.error ?? "The request failed." };
    }
    return {};
  } catch {
    return { error: "The design server is unreachable." };
  }
}

function VariationsProvider({ children }: { children: ReactNode }) {
  const [sets, setSets] = useState<VariationsState>({});
  const [focus, setFocus] = useState<VariationsFocus>(undefined);

  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl("/api/variations"))
      .then((response) => response.json() as Promise<StatusPayload>)
      .then((payload) => {
        if (!cancelled) setSets(setsFromStatus(payload));
      })
      .catch(() => {
        // No server / legacy server — the feature stays dormant.
      });

    const eventSource = new EventSource(apiUrl("/api/events"));
    eventSource.addEventListener("variations-event", (messageEvent) => {
      try {
        const event = JSON.parse(
          (messageEvent as MessageEvent).data as string,
        ) as VariationsEvent;
        setSets((current) => applyVariationsEvent(current, event));
        // Variant files changed on disk — nudge the Changes tab.
        if (
          event.kind === "landed" ||
          event.kind === "updated" ||
          event.kind === "resolved"
        ) {
          notifyFileWritten(event.path);
        }
        // A resolved/removed slug can leave a stale focus behind.
        if (event.kind === "resolved") {
          setFocus((current) =>
            current?.base === event.base ? undefined : current,
          );
        }
      } catch {
        // Ignore malformed events.
      }
    });
    return () => {
      cancelled = true;
      eventSource.close();
    };
  }, []);

  const api: VariationsApi = {
    sets,
    focus,
    setFocus,
    generate: (params) => post("/api/variations/generate", params),
    iterate: (params) => post("/api/variations/iterate", params),
    retry: (params) => post("/api/variations/retry", params),
    resolve: (params) => post("/api/variations/resolve", params),
  };

  return (
    <VariationsContext.Provider value={api}>
      {children}
    </VariationsContext.Provider>
  );
}

/** The variations api, or undefined outside the provider (cells/fixtures). */
function useVariationsApi(): VariationsApi | undefined {
  return useContext(VariationsContext);
}

export { VariationsProvider, useVariationsApi };
export type { VariationsApi };
