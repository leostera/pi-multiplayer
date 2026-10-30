/**
 * The wire between a Pi client and a durable session host: one JSON object per line.
 *
 * The host owns a pi-durable Harness and one conversation. The client submits input and aborts,
 * and receives the conversation's agent events (`watchEvents`) as they are committed. Nothing is
 * sent to the client that the host has not already stored.
 *
 * For the spike this runs over a Unix socket; in Axo it would be a WebSocket to a Durable Object.
 */

import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

export type ClientRequest =
  | { id: number; op: "submit"; requestId: string; content: string; whenBusy: Delivery }
  | { id: number; op: "abort" };

export type HostMessage =
  /** `tools`: the names of the tools the conversation offers, so Pi can stand in for each. */
  | { type: "snapshot"; snapshot: SnapshotEvent; tools: string[] }
  | { type: "events"; events: readonly AgentEvent[] }
  | { type: "reply"; id: number; ok: true; result: SubmitResult | null }
  | { type: "reply"; id: number; ok: false; error: string };

/** How a busy conversation takes the input: after the current tool round, or once the run answers. */
export type Delivery = "steer" | "followUp";

export type SubmitResult = { submissionId: number };

/** Splits a byte stream into lines at `\n` only (JSON strings may hold U+2028/U+2029). */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return chunk => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}
