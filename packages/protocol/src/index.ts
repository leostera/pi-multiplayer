/**
 * The wire between clients and a session server: one JSON object per message (a line on a Unix
 * socket, a frame on a WebSocket).
 *
 * The server owns a pi-durable Harness and one conversation. Clients submit input, write peer
 * messages (another agent's turns, from the ATXF bridge), and abort. They receive the
 * conversation's agent events (`watchEvents`) as they are committed. Nothing is sent to a client
 * that the server has not already stored.
 */

import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

export type ClientRequest =
  | { id: number; op: "submit"; requestId: string; author: string; content: string; whenBusy: Delivery }
  | { id: number; op: "write"; requestId: string; peer: PeerData }
  | { id: number; op: "abort" };

export type HostMessage =
  | { type: "snapshot"; snapshot: SnapshotEvent; session: SessionInfo }
  | { type: "events"; events: readonly AgentEvent[] }
  | { type: "reply"; id: number; ok: true; result: SubmitResult | null }
  | { type: "reply"; id: number; ok: false; error: string };

/** What a client shows about the session it attached to. */
export interface SessionInfo {
  /** The agent's display name. */
  agent: string;
  /** `provider/id` of the agent's model. */
  model: string;
  /** The tools the conversation offers, so Pi can stand in for each. */
  tools: string[];
  /**
   * Who the server says this client is (from Cloudflare Access, say). When set, the server signs
   * this client's messages with it, whatever the client sends.
   */
  you?: string;
}

/**
 * Inputs are placed as this entry kind, with who wrote them. The model sees `author: text`, so
 * in a shared session it knows who is asking.
 */
export const MESSAGE_KIND = "multiplayer.message";
export interface MessageData {
  author: string;
  text: string;
}

/**
 * Another agent's messages (an OpenCode session joined through ATXF), written into the
 * conversation without starting a run. The model sees them as user messages that say whose
 * they are.
 */
export const PEER_KIND = "multiplayer.peer";
export interface PeerData {
  /** The other agent, e.g. `opencode`. */
  agent: string;
  /** Who wrote it: a person's name for their messages, the agent's for its own. */
  author: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** The ATXF record this message came from, so the bridge does not send it back. */
  atxfId?: string;
}

/** How a busy conversation takes the input: after the current tool round, or once the run answers. */
export type Delivery = "steer" | "followUp";

export type SubmitResult = { submissionId: number };

/** Splits a byte stream into lines at `\n` only (JSON strings may hold U+2028/U+2029). */
export function lineSplitter(onLine: (line: string) => void): (chunk: Uint8Array | string) => void {
  let buffer = "";
  const decoder = new TextDecoder();
  return chunk => {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}
