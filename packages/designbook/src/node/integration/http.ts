/**
 * Tiny HTTP helpers shared by core API handlers and integration-plugin route
 * handlers (part of the node-side integration seam). Extracted from api.ts so
 * plugins don't reimplement body/JSON plumbing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody<T>(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBytes) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(rawBody || "{}") as T;
}

export { readJsonBody, sendJson };
