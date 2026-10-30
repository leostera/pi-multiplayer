/**
 * A pi-multiplayer session, seen as an ATXF transcript, and ATXF records, seen as session input.
 *
 * The projection is a pure function of the session's entries, so it gives the same records,
 * with the same reconciliation keys, every time it runs: pushing it again into the shared file
 * adds nothing. Messages another agent wrote (peer entries) project to the very record they came
 * from, so they are not shared twice either.
 */

import type { AssistantBlock, EntryRecord as AtxfRecord, MessageRecord, Transcript, UserContent } from "@leostera/atxf";
import { contentText } from "@leostera/atxf";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { MESSAGE_KIND, PEER_KIND, type MessageData, type PeerData } from "@pi-multiplayer/protocol";

export const RECORD_PREFIX = "pm-";

export interface ProjectOptions {
  /** Names the transcript; the same session always projects to the same id. */
  sessionId: string;
  /** The session's agent, named on its messages. */
  agent: string;
  /** Records of the shared file, by id: where peer entries came from. */
  shared: ReadonlyMap<string, AtxfRecord>;
}

export function project(entries: readonly EntryRecord[], options: ProjectOptions): Transcript {
  const records: AtxfRecord[] = [];
  let parentId: string | null = null;
  let firstTime: string | undefined;
  const add = (record: AtxfRecord) => {
    records.push(record);
    parentId = record.id;
    firstTime ??= record.time;
  };

  for (const entry of entries) {
    const id = `${RECORD_PREFIX}${entry.id}`;
    const message = entry.model?.[0];
    const time = new Date(message && "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0).toISOString();

    if (entry.kind === PEER_KIND) {
      const peer = entry.data as unknown as PeerData;
      const original = peer.atxfId === undefined ? undefined : options.shared.get(peer.atxfId);
      // Its own record, unchanged, keeps its key; it may sit on another branch of the file.
      if (original) add(original);
      continue;
    }
    if (entry.kind === MESSAGE_KIND) {
      const data = entry.data as unknown as MessageData;
      add({ type: "message", id, time, parentId, role: "user", content: data.text, origin: { kind: "human", name: data.author } });
      continue;
    }
    for (const [index, model] of (entry.model ?? []).entries()) {
      const recordId = index === 0 ? id : `${id}.${index}`;
      if (model.role === "assistant") {
        const content: AssistantBlock[] = [];
        for (const part of model.content) {
          if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
          else if (part.type === "thinking" && part.thinking) content.push({ type: "reasoning", text: part.thinking });
          else if (part.type === "toolCall") content.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
        }
        if (content.length === 0) continue;
        add({
          type: "message",
          id: recordId,
          time: new Date(model.timestamp).toISOString(),
          parentId,
          role: "assistant",
          content,
          origin: { kind: "model", name: options.agent },
          model: { provider: model.provider, id: model.model },
          stop: model.stopReason === "toolUse" ? "tool_use" : model.stopReason === "stop" ? "end" : model.stopReason === "length" ? "max_tokens" : model.stopReason === "aborted" ? "aborted" : model.stopReason === "error" ? "error" : "other",
        });
      } else if (model.role === "toolResult") {
        add({
          type: "message",
          id: recordId,
          time: new Date(model.timestamp).toISOString(),
          parentId,
          role: "tool",
          toolCallId: model.toolCallId,
          toolName: model.toolName,
          content: model.content.map(part => (part.type === "text" ? part.text : `[${part.type}]`)).join(""),
          ...(model.isError ? { isError: true } : {}),
        });
      } else if (model.role === "user" && entry.kind !== "pi.system") {
        // Input that is not a person's message (a hook's, an extension's): shown as such.
        add({ type: "message", id: recordId, time, parentId, role: "user", content: userText(model.content), origin: { kind: "extension", name: entry.kind } });
      }
    }
  }

  return {
    header: {
      type: "transcript",
      atxf: "0.1",
      id: options.sessionId,
      time: firstTime ?? new Date(0).toISOString(),
      title: `pi-multiplayer: ${options.sessionId}`,
      source: { agent: "pi-multiplayer" },
    },
    records,
  };
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.map(part => part.text ?? "").join("");
}

/**
 * The message records of the shared file that the session does not have, in file order: not
 * projected from it, and not written into it before.
 */
export function newPeerRecords(shared: Transcript, known: ReadonlySet<string>): MessageRecord[] {
  return shared.records.filter(
    (record): record is MessageRecord =>
      record.type === "message" &&
      !record.id.startsWith(RECORD_PREFIX) &&
      !known.has(record.id) &&
      record.role !== "system" &&
      record.display !== false,
  );
}

/** What a record says, as a peer message from `agent`. Null for nothing worth showing. */
export function peerFromRecord(record: MessageRecord, agent: string, author: string): PeerData | null {
  const text = recordText(record);
  if (!text.trim()) return null;
  if (record.role === "user") {
    // A person's message; anything else in a user role (a command's output, a hook) is context.
    const human = record.origin === undefined || record.origin.kind === "human";
    return { agent, author: human ? (record.origin?.name ?? author) : (record.origin?.name ?? record.origin!.kind), role: human ? "user" : "tool", text, atxfId: record.id };
  }
  if (record.role === "assistant") return { agent, author: agent, role: "assistant", text, atxfId: record.id };
  return { agent, author: agent, role: "tool", text: `${"toolName" in record && record.toolName ? `${record.toolName}: ` : ""}${text}`, atxfId: record.id };
}

function recordText(record: MessageRecord): string {
  if (record.role === "assistant") {
    return record.content
      .map(block => (block.type === "text" ? block.text : block.type === "tool_call" ? `[${block.name}(${JSON.stringify(block.arguments ?? block.input ?? {})})]` : ""))
      .filter(Boolean)
      .join("\n");
  }
  return contentText(record.content as UserContent);
}
