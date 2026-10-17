import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError } from "@get-bb/plugin-sdk";
import { Store, type Batch, type Entry } from "./store.js";

const eventPageSize = 100;
const bootId = `${process.pid}:${performance.timeOrigin}`;
const resumePrompt =
  "上次执行因 BB 服务升级中断。请先检查当前进度、仍在运行的命令和已有工具结果，避免重复执行已完成的操作，然后继续完成原任务。";
const eventTypes = [
  "client/turn/requested",
  "turn/completed",
  "system/thread/interrupted",
  "system/interaction/lifecycle",
] as const;

export class Recovery {
  private tail: Promise<unknown> = Promise.resolve();
  private cancelRequested = false;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: Store,
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }

  status(): Batch | null {
    return this.store.load();
  }

  prepare(projectId?: string): Promise<Batch> {
    return this.serial(async () => {
      const previous = this.store.load();
      if (
        previous &&
        (previous.state === "armed" || previous.state === "recovering")
      ) {
        throw new PluginCliError("A recovery batch is already active.", {
          code: "batch_active",
          hint: "Inspect `bb upgrade-resume status` or run `bb upgrade-resume cancel` first.",
        });
      }
      this.cancelRequested = false;
      const preparedAt = Date.now();
      const running = await this.bb.sdk.threads.listRunning();
      const entries: Entry[] = [];
      for (const runningThread of running) {
        const thread = await this.bb.sdk.threads.get({
          threadId: runningThread.id,
        });
        if (projectId && thread.projectId !== projectId) continue;
        if (
          thread.status !== "active" ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null
        )
          continue;
        const interactions = await this.bb.sdk.threads.interactions.list({
          threadId: thread.id,
        });
        if (
          interactions.some(
            (interaction) =>
              interaction.status === "pending" ||
              interaction.status === "resolving",
          )
        )
          continue;
        const [requests, latest] = await Promise.all([
          this.bb.sdk.threads.events.list({
            threadId: thread.id,
            types: ["client/turn/requested"],
            order: "desc",
            limit: "1",
          }),
          this.bb.sdk.threads.events.list({
            threadId: thread.id,
            types: [...eventTypes],
            order: "desc",
            limit: "1",
          }),
        ]);
        const request = requests[0];
        if (request?.type !== "client/turn/requested") continue;
        entries.push({
          threadId: thread.id,
          hostId: runningThread.hostId,
          requestId: request.data.requestId,
          requestSeq: request.seq,
          checkpointSeq: latest[0]?.seq ?? request.seq,
          state: "pending",
          detail: "Waiting for the BB server process to restart.",
        });
      }
      const batch: Batch = {
        id: randomUUID(),
        bootId,
        preparedAt,
        state: entries.length ? "armed" : "finished",
        entries,
      };
      this.store.save(batch);
      return batch;
    });
  }

  cancel(): Promise<Batch | null> {
    this.cancelRequested = true;
    return this.serial(async () => {
      const batch = this.store.load();
      if (!batch) return null;
      batch.state = "cancelled";
      for (const entry of batch.entries) {
        if (entry.state === "pending") {
          entry.state = "skipped";
          entry.detail = "Recovery cancelled by the operator.";
        }
      }
      this.store.save(batch);
      return batch;
    });
  }

  sweep(signal: AbortSignal): Promise<Batch | null> {
    return this.serial(async () => {
      const batch = this.store.load();
      if (
        !batch ||
        batch.state === "cancelled" ||
        batch.state === "finished" ||
        batch.bootId === bootId ||
        signal.aborted
      )
        return batch;
      batch.state = "recovering";
      for (const entry of batch.entries) {
        if (signal.aborted || this.cancelRequested) break;
        if (entry.state === "sending") {
          entry.state = "uncertain";
          entry.detail =
            "BB stopped during dispatch. Inspect the thread before continuing it manually.";
        }
        if (entry.state !== "pending") continue;
        try {
          await this.recover(batch, entry, signal);
        } catch (error) {
          if (wasSending(entry)) {
            entry.state = "uncertain";
            entry.detail = `Dispatch outcome is unknown; inspect the thread: ${errorMessage(error)}`;
          } else if (isNotFound(error)) {
            entry.state = "skipped";
            entry.detail = "Thread or machine no longer exists.";
          } else {
            entry.detail = `Waiting to check readiness: ${errorMessage(error)}`;
          }
        }
        this.store.save(batch);
      }
      if (
        batch.entries.every(
          (entry) => entry.state !== "pending" && entry.state !== "sending",
        )
      )
        batch.state = "finished";
      this.store.save(batch);
      return batch;
    });
  }

  private async recover(
    batch: Batch,
    entry: Entry,
    signal: AbortSignal,
  ): Promise<void> {
    const thread = await this.bb.sdk.threads.get({
      threadId: entry.threadId,
      signal,
    });
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      skip(entry, "Thread was archived or deleted.");
      return;
    }
    const latest = await this.bb.sdk.threads.events.list({
      threadId: entry.threadId,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
      signal,
    });
    const request = latest[0];
    if (
      request?.type !== "client/turn/requested" ||
      request.data.requestId !== entry.requestId
    ) {
      skip(entry, "A newer dispatch already took over this thread.");
      return;
    }
    let cursor = entry.checkpointSeq;
    let interrupted = false;
    while (true) {
      const events = await this.bb.sdk.threads.events.list({
        threadId: entry.threadId,
        types: [...eventTypes],
        afterSeq: String(cursor),
        order: "asc",
        limit: String(eventPageSize),
        signal,
      });
      for (const event of events) {
        cursor = event.seq;
        if (event.type === "client/turn/requested") {
          skip(entry, "A newer dispatch already took over this thread.");
          return;
        }
        if (event.type === "system/thread/interrupted") {
          if (event.data.reason !== "host-daemon-restarted") {
            skip(
              entry,
              `Thread was stopped for another reason: ${event.data.reason}.`,
            );
            return;
          }
          interrupted = true;
        }
        if (
          event.type === "turn/completed" &&
          event.data.status === "completed"
        ) {
          skip(entry, "The recorded task completed.");
          return;
        }
        if (
          event.type === "system/interaction/lifecycle" &&
          (event.data.interaction.status === "pending" ||
            event.data.interaction.status === "resolving")
        ) {
          skip(
            entry,
            "The task reached an approval or question; leave it for the user.",
          );
          return;
        }
      }
      if (events.length < eventPageSize) break;
    }
    if (!interrupted) {
      entry.detail =
        "Waiting for evidence that the recorded task was interrupted by the daemon restart.";
      return;
    }
    if (thread.status !== "idle" && thread.status !== "error") {
      entry.detail = `Waiting for the thread to settle (currently ${thread.status}).`;
      return;
    }
    if (
      entry.hostId === null ||
      (await this.bb.sdk.hosts.get({ hostId: entry.hostId, signal })).status !==
        "connected"
    ) {
      entry.detail = "Waiting for the original machine to reconnect.";
      return;
    }
    const interactions = await this.bb.sdk.threads.interactions.list({
      threadId: entry.threadId,
      signal,
    });
    if (
      interactions.some(
        (interaction) =>
          interaction.status === "pending" ||
          interaction.status === "resolving",
      )
    ) {
      skip(entry, "The thread is waiting for user input.");
      return;
    }
    if (thread.queuedMessageCount > 0) {
      skip(entry, "The thread already has queued work to continue.");
      return;
    }
    if (signal.aborted || this.cancelRequested) return;
    entry.state = "sending";
    entry.detail =
      "Dispatch started; a lost response requires manual inspection.";
    this.store.save(batch);
    await this.bb.sdk.threads.send({
      threadId: entry.threadId,
      mode: "queue-if-active",
      input: [
        {
          type: "text",
          text: `${resumePrompt}\n\n[upgrade-resume:${batch.id}]`,
          mentions: [],
        },
      ],
      pluginSubmission: {
        pluginId: this.bb.pluginId,
        data: { batchId: batch.id, requestId: entry.requestId },
      },
    });
    entry.state = "resumed";
    entry.detail = "Continuation accepted by BB.";
  }
}

function skip(entry: Entry, detail: string): void {
  entry.state = "skipped";
  entry.detail = detail;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wasSending(entry: Entry): boolean {
  return entry.state === "sending";
}
