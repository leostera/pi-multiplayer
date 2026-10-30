/**
 * Keeps a pi-multiplayer session and an ATXF shared file in sync, so any agent that joins the
 * file (OpenCode's `/atxf join`, Pi's pi-atxf) takes part in the session.
 *
 * - The session, projected to ATXF (see `project.ts`), is pushed into the file whenever it gains
 *   entries. The agents on the file pull it between their turns.
 * - Records the file gains from those agents are written into the session as peer messages:
 *   context for its agent and everyone attached, under the other agent's name. They start no run.
 *
 * Writes are keyed by the record's id, so restarting the bridge writes nothing twice.
 */

import { watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { EntryRecord as AtxfRecord } from "@leostera/atxf";
import { push, readShared } from "@leostera/atxf/sync";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { connectConversation, type ConnectOptions } from "@pi-multiplayer/client";
import { PEER_KIND, type PeerData } from "@pi-multiplayer/protocol";
import { newPeerRecords, peerFromRecord, project } from "./project.ts";

export interface BridgeOptions extends ConnectOptions {
  /** The session: its URL or socket path. */
  target: string;
  /** The ATXF shared file. */
  file: string;
  /** The agent on the other side of the file. Default `opencode`. */
  agent?: string;
  /** Who that agent's user messages are from, when a record does not say. Default `$USER`. */
  author?: string;
  log?: (line: string) => void;
}

export interface Bridge {
  /** Resolves when the session connection is lost. */
  readonly closed: Promise<void>;
  close(): void;
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const file = resolve(options.file);
  const agent = options.agent ?? "opencode";
  const author = options.author ?? process.env.USER ?? "someone";
  const log = options.log ?? (() => {});
  const remote = await connectConversation(options.target, options);
  const sessionId = `pi-multiplayer:${sessionName(options.target)}`;

  const entries = new Map<number, EntryRecord>();
  const written = new Set<string>();
  const shared = new Map<string, AtxfRecord>();
  const remember = (entry: EntryRecord) => {
    entries.set(Number(entry.id), entry);
    if (entry.kind === PEER_KIND) {
      const atxfId = (entry.data as unknown as PeerData).atxfId;
      if (atxfId) written.add(atxfId);
    }
  };
  remote.snapshot.entries.forEach(remember);

  let queue: Promise<void> = Promise.resolve();
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const sync = () => {
    clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      queue = queue.then(once).catch(error => log(`sync failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 150);
  };

  async function once() {
    const file_ = await readShared(file);
    if (file_) {
      for (const record of file_.records) shared.set(record.id, record);
      for (const record of newPeerRecords(file_, written)) {
        written.add(record.id);
        const peer = peerFromRecord(record, agent, author);
        if (!peer) continue;
        await remote.write(`atxf:${sessionId}:${record.id}`, peer);
        log(`${peer.author} (${agent}) → session: ${peer.text.slice(0, 80).replace(/\s+/g, " ")}`);
      }
    }
    const ordered = [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const { added } = await push(file, project(ordered, { sessionId, agent: remote.session.agent, shared }));
    if (added > 0) log(`session → ${basename(file)}: ${added} record${added === 1 ? "" : "s"}`);
  }

  remote.onEvents(events => {
    let changed = false;
    for (const event of events) {
      const entry = entryOf(event);
      if (entry) {
        remember(entry);
        changed = true;
      }
    }
    if (changed) sync();
  });
  const watcher = watch(dirname(file), (_event, name) => {
    if (name === basename(file)) sync();
  });
  const closed = new Promise<void>(done =>
    remote.onClose(() => {
      watcher.close();
      done();
    }),
  );
  sync();
  log(`bridging ${options.target} (${remote.session.agent}) and ${file} (${agent})`);

  return {
    closed,
    close: () => {
      watcher.close();
      remote.close();
    },
  };
}

function entryOf(event: AgentEvent): EntryRecord | undefined {
  if (event.type === "message_end" || event.type === "entry_appended") return event.entry;
  if (event.type === "tool_execution_end") return event.entry;
  return undefined;
}

function sessionName(target: string): string {
  return target.replace(/\/+$/, "").split("/").pop()!.replace(/\.sock$/, "") || "session";
}
