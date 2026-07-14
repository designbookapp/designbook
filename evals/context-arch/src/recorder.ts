/**
 * Per-LLM-call recorder, installed as an inline pi extension
 * (DefaultResourceLoader `extensionFactories`).
 *
 * - `before_provider_request` → persists the FULL raw provider request
 *   payload (one JSONL line per call) and starts the latency clock.
 * - `after_provider_response` → latency + HTTP status.
 * - `message_end` (assistant) → tokens (input/output/cacheRead/cacheWrite),
 *   cost, stop reason, model.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CallRecord } from "./types.ts";

export type Recorder = {
  /** Inline extension factory to pass to DefaultResourceLoader. */
  extension: (pi: ExtensionAPI) => void;
  /** Harness sets this before each scripted user turn. */
  setTurn: (turn: number) => void;
  calls: CallRecord[];
  totalCostUSD: () => number;
};

export function createRecorder(opts: {
  payloadPath: string;
  maxCalls: number;
  /** Called when maxCalls is exceeded or spend cap hit — harness aborts. */
  onOverrun: (reason: string) => void;
  /** Session-level spend cap in USD (safety net; caller also caps globally). */
  costCapUSD: number;
}): Recorder {
  const calls: CallRecord[] = [];
  let turn = 0;
  let cost = 0;

  const extension = (pi: ExtensionAPI) => {
    pi.on("before_provider_request", (event) => {
      const payload = event.payload as
        | {
            messages?: unknown[];
            system?: unknown;
            tools?: unknown[];
          }
        | undefined;
      const record: CallRecord = {
        call: calls.length,
        turn,
        tStart: Date.now(),
      };
      try {
        const json = JSON.stringify(payload);
        record.contextBytes = Buffer.byteLength(json ?? "", "utf8");
        record.contextMessages = Array.isArray(payload?.messages)
          ? payload.messages.length
          : undefined;
        record.systemBytes = payload?.system
          ? Buffer.byteLength(JSON.stringify(payload.system), "utf8")
          : 0;
        record.toolCount = Array.isArray(payload?.tools)
          ? payload.tools.length
          : 0;
        appendFileSync(
          opts.payloadPath,
          JSON.stringify({
            call: record.call,
            turn,
            ts: new Date(record.tStart).toISOString(),
            payload,
          }) + "\n",
        );
      } catch {
        // Payload not serializable — record shape-less.
      }
      calls.push(record);
      if (calls.length > opts.maxCalls) {
        opts.onOverrun(`LLM call count exceeded ${opts.maxCalls}`);
      }
    });

    pi.on("after_provider_response", (event) => {
      const last = calls[calls.length - 1];
      if (last && last.latencyMs === undefined) {
        last.latencyMs = Date.now() - last.tStart;
        last.httpStatus = event.status;
      }
    });

    pi.on("message_end", (event) => {
      const message = event.message as {
        role?: string;
        usage?: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          cost?: { total?: number };
        };
        stopReason?: string;
        model?: string;
        errorMessage?: string;
      };
      if (message?.role !== "assistant" || !message.usage) return;
      // Attach to the most recent call without usage (calls are sequential).
      const target =
        [...calls].reverse().find((c) => c.usage === undefined) ??
        calls[calls.length - 1];
      if (!target) return;
      target.usage = {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
      };
      target.costUSD = message.usage.cost?.total ?? 0;
      target.stopReason = message.stopReason;
      target.model = message.model;
      if (message.errorMessage) target.errorMessage = message.errorMessage;
      cost += target.costUSD;
      if (cost > opts.costCapUSD) {
        opts.onOverrun(
          `session spend $${cost.toFixed(2)} exceeded cap $${opts.costCapUSD}`,
        );
      }
    });
  };

  return {
    extension,
    setTurn: (t) => {
      turn = t;
    },
    calls,
    totalCostUSD: () => cost,
  };
}
