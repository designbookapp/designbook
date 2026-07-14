/**
 * Mock Anthropic Messages endpoint for keyless dry runs.
 *
 * Speaks just enough of the streaming SSE protocol for @anthropic-ai/sdk
 * (which pi-ai uses under the hood, with `baseURL: model.baseUrl`).
 *
 * Replay mode (no `state_update` tool in the request): a short text message
 * and `end_turn` — enough to exercise the harness end-to-end.
 *
 * Curated mode (request tools include `state_update`): a scripted loop that
 * exercises the assembler's custom tools deterministically —
 *   fresh user turn        → one `state_update` tool_use
 *   after state_update     → every 3rd turn, one `recall` tool_use; else text
 *   after recall           → text + end_turn
 * Tool ids are prefixed (`toolu_mockstate_` / `toolu_mockrecall_`) so the
 * stateless server can tell where it is in the script from the request body.
 *
 * Port policy: 8815 only (per eval constraints).
 */

import { createServer, type Server } from "node:http";

export const MOCK_PORT = 8815;

type Blk = { type: string; text?: string; tool_use_id?: string; [k: string]: unknown };
type PMsg = { role: string; content: string | Blk[] };

function lastToolResultId(messages: PMsg[]): string | undefined {
  // The state doc is always the trailing user message in curated mode; the
  // message just before it is the newest REAL message. Only when THAT message
  // is a tool_result are we mid-tool-loop (a fresh user prompt means a new turn).
  const prev = messages[messages.length - 2];
  if (!prev || !Array.isArray(prev.content)) return undefined;
  for (const b of prev.content) {
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") return b.tool_use_id;
  }
  return undefined;
}

function turnCount(messages: PMsg[]): number {
  // Curated keep-log entries carry "[turn N] USER:" markers.
  const first = messages[0];
  if (!Array.isArray(first?.content)) return 1;
  let n = 0;
  for (const b of first.content) {
    if (b.type === "text" && typeof b.text === "string" && /^\[turn \d+\] USER:/.test(b.text)) n++;
  }
  return Math.max(1, n);
}

export function startMockServer(): Promise<Server> {
  const server = createServer((req, res) => {
    if (!req.url?.includes("/messages")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let inputChars = body.length;
      let messages: PMsg[] = [];
      let toolNames: string[] = [];
      try {
        const parsed = JSON.parse(body) as { messages?: PMsg[]; tools?: { name: string }[] };
        messages = parsed.messages ?? [];
        toolNames = (parsed.tools ?? []).map((t) => t.name);
        inputChars = JSON.stringify(messages).length;
      } catch {
        // keep raw length
      }
      const inputTokens = Math.max(1, Math.round(inputChars / 4));

      // Decide the scripted step.
      const curated = toolNames.includes("state_update");
      let step: "text" | "state_update" | "recall" = "text";
      if (curated) {
        const trid = lastToolResultId(messages);
        if (!trid || (!trid.startsWith("toolu_mockstate_") && !trid.startsWith("toolu_mockrecall_"))) {
          step = "state_update";
        } else if (
          trid.startsWith("toolu_mockstate_") &&
          toolNames.includes("recall") &&
          turnCount(messages) % 3 === 0
        ) {
          step = "recall";
        }
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_mock_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: "mock-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      });

      let outputTokens: number;
      if (step === "state_update" || step === "recall") {
        const id =
          step === "state_update"
            ? `toolu_mockstate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
            : `toolu_mockrecall_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const input =
          step === "state_update"
            ? { op: "set", section: "current_task", content: `mock task state (turn ${turnCount(messages)})` }
            : { pattern: "USER", max_matches: 3 };
        const json = JSON.stringify(input);
        outputTokens = Math.max(1, Math.round(json.length / 4));
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id, name: step, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: json },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
      } else {
        const text = "MOCK: acknowledged. (dry-run provider — no real model)";
        outputTokens = Math.max(1, Math.round(text.length / 4));
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
      }
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}
