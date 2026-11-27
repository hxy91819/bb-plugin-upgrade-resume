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
  "client/turn/rejected",
  "turn/input/accepted",
  "turn/completed",
  "system/error",
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
        const [checkpoint] = await this.bb.sdk.threads.events.list({
          threadId: thread.id,
          types: [...eventTypes],
          order: "desc",
          limit: "1",
        });
        if (!checkpoint) continue;
        const request =
          checkpoint.type === "client/turn/requested"
            ? checkpoint
            : (
                await this.bb.sdk.threads.events.list({
                  threadId: thread.id,
                  types: ["client/turn/requested"],
                  beforeSeq: String(checkpoint.seq),
                  order: "desc",
                  limit: "1",
                })
              )[0];
        if (request?.type !== "client/turn/requested") continue;
        entries.push({
          threadId: thread.id,
          hostId: runningThread.hostId,
          requestId: request.data.requestId,
          requestSeq: request.seq,
          checkpointSeq: checkpoint.seq,
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
      const recoveryBootAt = batch.recoveryBootAt ?? performance.timeOrigin;
      if (batch.recoveryBootAt === undefined) {
        batch.recoveryBootAt = recoveryBootAt;
        batch.state = "recovering";
        this.store.save(batch);
      }
      for (const entry of batch.entries) {
        if (signal.aborted || this.cancelRequested) break;
        if (entry.state === "sending") {
          entry.state = "uncertain";
          entry.detail =
            "BB stopped during dispatch. Inspect the thread before continuing it manually.";
        }
        if (entry.state !== "pending") continue;
        try {
          await this.recover(batch, entry, recoveryBootAt, signal);
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
    recoveryBootAt: number,
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
      request.seq < entry.requestSeq ||
      (request.seq === entry.requestSeq &&
        request.data.requestId !== entry.requestId)
    ) {
      skip(entry, "The recorded dispatch is no longer available.");
      return;
    }
    const successor = request.seq > entry.requestSeq;
    if (successor && request.createdAt >= recoveryBootAt) {
      skip(entry, "A newer dispatch already took over this thread.");
      return;
    }
    let cursor = successor ? request.seq : entry.checkpointSeq;
    let turnId: string | undefined;
    let matchingInterruption = false;
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
          entry.detail =
            "Dispatch changed while checking the thread; checking again on the next pass.";
          return;
        }
        if (
          successor &&
          event.type === "turn/input/accepted" &&
          event.data.clientRequestId === request.data.requestId &&
          event.scope.kind === "turn"
        ) {
          if (event.createdAt >= recoveryBootAt) {
            skip(entry, "A newer dispatch already took over this thread.");
            return;
          }
          turnId = event.scope.turnId;
        }
        if (
          successor &&
          event.type === "client/turn/rejected" &&
          event.data.requestId === request.data.requestId
        ) {
          skip(entry, "The newer dispatch was rejected.");
          return;
        }
        const matchesTurn =
          !successor ||
          (event.scope.kind === "turn" && event.scope.turnId === turnId);
        if (event.type === "turn/completed") {
          matchingInterruption =
            matchesTurn && event.data.status === "interrupted";
          if (matchesTurn && event.data.status === "completed") {
            skip(entry, "The latest task completed.");
            return;
          }
        }
        if (event.type === "system/thread/interrupted") {
          if (event.data.reason !== "host-daemon-restarted") {
            skip(
              entry,
              `Thread was stopped for another reason: ${event.data.reason}.`,
            );
            return;
          }
          interrupted ||= !successor || matchingInterruption;
        }
        if (
          event.type === "system/error" &&
          event.data.code === "provider_process_exited" &&
          matchesTurn &&
          event.createdAt < recoveryBootAt
        ) {
          interrupted = true;
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
    if (successor && !turnId) {
      entry.detail =
        "Waiting for evidence that the newer dispatch started before the server restarted.";
      return;
    }
    if (!interrupted) {
      entry.detail =
        "Waiting for a daemon interruption or a provider process exit before this server started.";
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
    const current = await this.bb.sdk.threads.get({
      threadId: entry.threadId,
      signal,
    });
    if (current.archivedAt !== null || current.deletedAt !== null) {
      skip(entry, "Thread was archived or deleted.");
      return;
    }
    if (current.queuedMessageCount > 0) {
      skip(entry, "The thread already has queued work to continue.");
      return;
    }
    if (current.status !== "idle" && current.status !== "error") {
      entry.detail = `Waiting for the thread to settle (currently ${current.status}).`;
      return;
    }
    const [changed] = await this.bb.sdk.threads.events.list({
      threadId: entry.threadId,
      types: [...eventTypes],
      afterSeq: String(cursor),
      order: "asc",
      limit: "1",
      signal,
    });
    if (changed) {
      entry.detail =
        "Thread changed before dispatch; checking again on the next pass.";
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
        data: { batchId: batch.id, requestId: request.data.requestId },
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
