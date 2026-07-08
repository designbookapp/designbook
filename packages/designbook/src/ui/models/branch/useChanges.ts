/**
 * Live changes state for the Changes tab (Changes tab MVP). Stateful hook at
 * the composition-root altitude (like `useWorktrees`): `Workbench` calls it
 * and feeds the state + bound actions to `ChangesProvider`.
 *
 * Refresh strategy (spec, decision #5):
 *   1. initial fetch on mount, and refetch on Changes tab activation
 *      (`active` flipping true);
 *   2. SSE `pi-event` `agent_end` — Pi just finished editing;
 *   3. `designbook:fileWritten` window events — designbook's own write
 *      actions (Code-tab save, adapter writes) announce themselves;
 *   4. a 10s poll ONLY while the Changes tab is visible (git status is a few
 *      ms on a normal repo; external IDE edits have no signal today).
 */

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@designbook-ui/designbook";
import { onFileWritten } from "@designbook-ui/fileWriteBus";
import type { FileChange } from "./changesModel";

const POLL_INTERVAL_MS = 10_000;

type ChangesState = { git: boolean; changes: FileChange[] };

function useChanges({ active }: { active: boolean }) {
  const [state, setState] = useState<ChangesState>({ git: true, changes: [] });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    void fetch(apiUrl("/api/changes"))
      .then(
        (response) =>
          response.json() as Promise<{ git?: unknown; changes?: unknown }>,
      )
      .then((payload) => {
        setState({
          git: payload.git !== false,
          changes: Array.isArray(payload.changes)
            ? (payload.changes as FileChange[])
            : [],
        });
        setLoaded(true);
      })
      .catch(() => {
        // Keep the last known list; the next signal retries.
      });
  }, []);

  // Initial fetch (canvas badges need data before the tab is ever opened).
  useEffect(() => refresh(), [refresh]);

  // Pi finished a turn — its edits are on disk now.
  useEffect(() => {
    const eventSource = new EventSource(apiUrl("/api/events"));
    eventSource.addEventListener("pi-event", (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data as string) as {
          type?: string;
        };
        if (event.type === "agent_end") refresh();
      } catch {
        // Ignore malformed events.
      }
    });
    return () => eventSource.close();
  }, [refresh]);

  // designbook's own write actions announce themselves on the bus.
  useEffect(() => onFileWritten(() => refresh()), [refresh]);

  // Tab activation refetch + visible-tab poll backstop.
  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const discard = useCallback(
    async (path: string) => {
      const response = await fetch(apiUrl("/api/changes/discard"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "Unable to discard the changes.");
      }
      refresh();
    },
    [refresh],
  );

  return { git: state.git, changes: state.changes, loaded, refresh, discard };
}

export { useChanges };
