/**
 * A human-readable trace of what a durable conversation does, for watching a host while it runs.
 *
 * One line per step: runs, turns, the model's text and tool calls, each call's output as it
 * streams, and how submissions are placed and settled. `raw` prints every agent event as JSON.
 */

import type { AgentEvent } from "@earendil-works/pi-durable";

export interface TraceOptions {
  raw?: boolean;
  write?: (line: string) => void;
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
export const dim = paint("2");
const bold = paint("1");
const cyan = paint("36");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const magenta = paint("35");

export function stamp(): string {
  return dim(new Date().toISOString().slice(11, 23));
}

export function logLine(text: string, write: (line: string) => void = line => console.log(line)): void {
  write(`${stamp()} ${text}`);
}

/** Returns a listener for `watchEvents` batches that prints each event. */
export function traceEvents(options: TraceOptions = {}): (events: readonly AgentEvent[]) => void {
  const write = options.write ?? (line => console.log(line));
  const log = (text: string) => logLine(text, write);
  // Per-call output already printed, so streamed output is printed once.
  const printed = new Map<string, number>();

  return events => {
    for (const event of events) {
      if (options.raw) log(dim(JSON.stringify(event)));
      switch (event.type) {
        case "snapshot":
          log(`${bold("snapshot")} ${event.entries.length} entries${event.run ? ", a run in progress" : ""}`);
          break;
        case "run_start":
          log(bold(cyan(`▶ run started`)) + dim(` (inputs ${event.inputs.join(", ")})`));
          break;
        case "run_end":
          log(bold(cyan(`■ run ended`)) + dim(` (inputs ${event.inputs.join(", ")})`));
          break;
        case "turn_start":
          log(cyan("  turn"));
          break;
        case "message_start":
          if (event.message.role === "user") log(`${green("  user")} ${preview(text(event.message.content))}`);
          if (event.message.role === "assistant") {
            log(`${magenta("  model")} ${dim(`${event.message.provider}/${event.message.model} generating…`)}`);
          }
          if (event.message.role === "system") {
            const added = (event.message as { toolsAdded?: { name: string }[] }).toolsAdded?.map(tool => tool.name) ?? [];
            if (added.length > 0) log(dim(`  system prompt/tools sent (tools: ${added.join(", ")})`));
            else log(dim(`  system prompt sent`));
          }
          break;
        case "message_end": {
          const message = event.entry.model?.[0];
          if (message?.role !== "assistant") break;
          for (const block of message.content) {
            if (block.type === "thinking") log(`${magenta("  thinking")} ${dim(preview(block.thinking))}`);
            if (block.type === "text" && block.text.trim()) log(`${magenta("  says")} ${preview(block.text)}`);
            if (block.type === "toolCall") log(`${yellow("  calls")} ${bold(block.name)} ${preview(JSON.stringify(block.arguments))} ${dim(`[${block.id}]`)}`);
          }
          const usage = message.usage;
          log(
            dim(
              `  ${message.stopReason}; tokens in ${usage.input} out ${usage.output} cache r${usage.cacheRead}/w${usage.cacheWrite}` +
                (message.errorMessage ? `; error: ${message.errorMessage}` : ""),
            ),
          );
          break;
        }
        case "tool_execution_start":
          if (event.parentToolCallId === undefined) log(`${yellow("  ⚙ running")} ${bold(event.toolName)} ${dim(`[${event.toolCallId}]`)}`);
          else log(`${yellow("    ⚙ nested")} ${bold(event.toolName)} ${preview(JSON.stringify(event.args))}`);
          break;
        case "tool_execution_update": {
          if (!event.output) break;
          // Print only new output, line by line.
          const done = printed.get(event.toolCallId) ?? 0;
          const chunk = "set" in event.output ? event.output.set.slice(done) : (event.output.append ?? "");
          printed.set(event.toolCallId, done + chunk.length);
          for (const line of chunk.split("\n").filter(Boolean)) log(dim(`    │ ${line.slice(0, 200)}`));
          break;
        }
        case "tool_execution_end": {
          printed.delete(event.toolCallId);
          const result = event.entry?.model?.[0];
          if (result?.role === "toolResult") {
            const status = result.isError ? red("failed") : green("done");
            const duration = (result as { durationMs?: number }).durationMs;
            log(`  ${status} ${bold(event.toolName)}${duration !== undefined ? dim(` in ${duration} ms`) : ""}: ${dim(preview(text(result.content)))}`);
          } else if (event.parentToolCallId === undefined) {
            log(`  ${red("ended without a result")} ${bold(event.toolName)}`);
          }
          break;
        }
        case "submission": {
          const record = event.record;
          const who = record.requestId ? dim(` ${record.requestId}`) : "";
          const extra = record.status === "unanswered" ? red(` ${record.reason}${record.detail ? `: ${record.detail}` : ""}`) : "";
          log(`${green("  submission")} #${record.id} ${record.type} ${bold(record.status)}${who}${extra}`);
          break;
        }
        case "inbox_update":
          if (event.items.length > 0) log(dim(`  inbox: ${event.items.map(item => `#${item.id} ${item.mode}`).join(", ")}`));
          break;
        case "auto_retry_start":
          log(red(`  retry ${event.attempt} at ${new Date(event.at).toISOString().slice(11, 19)}: ${event.errorMessage}`));
          break;
        case "task_failed":
          log(red(`  task ${event.kind} #${event.taskId} failed: ${event.message}`));
          break;
        case "compaction_start":
          log(yellow(`  compacting (${event.reason}${event.blocking ? ", blocking" : ""})`));
          break;
        case "compaction_end":
          log(event.error ? red(`  compaction failed: ${event.error}`) : yellow(`  compacted`));
          break;
        case "agent_changed":
          log(dim(`  agent changed: ${JSON.stringify(event.agent).slice(0, 200)}`));
          break;
      }
    }
  };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (part?.type === "text" ? part.text : `[${part?.type}]`)).join("");
}

function preview(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
