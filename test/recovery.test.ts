import { afterEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import plugin from "../src/server.js";
import { Store } from "../src/store.js";

type Event = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function request(seq = 1, requestId = "req_original", createdAt = 1): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt,
    scope: { kind: "thread" },
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "Finish my task", mentions: [] }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "test-model",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        source: "client/turn/requested",
      },
    },
  };
}

function interruption(
  seq = 2,
  reason: "manual-stop" | "host-daemon-restarted" = "host-daemon-restarted",
): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt: Date.now(),
    scope: { kind: "thread" },
    type: "system/thread/interrupted",
    data: { reason },
  };
}

function completion(
  seq = 2,
  status: "completed" | "failed" | "interrupted" = "completed",
  turnId = "turn_1",
): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt: Date.now(),
    scope: { kind: "turn", turnId },
    type: "turn/completed",
    data: { providerThreadId: "provider_1", status },
  };
}

function accepted(seq: number, createdAt = performance.timeOrigin - 1): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt,
    scope: { kind: "turn", turnId: "turn_2" },
    type: "turn/input/accepted",
    data: { providerThreadId: "provider_1", clientRequestId: "req_new" },
  };
}

function processExit(
  seq = 3,
  createdAt = Date.now(),
  turnId = "turn_1",
): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt,
    scope: { kind: "turn", turnId },
    type: "system/error",
    data: {
      code: "provider_process_exited",
      message: 'Provider "codex" exited unexpectedly with code 0',
    },
  };
}

async function setup() {
  let thread: Thread = makeThreadResponse({
    id: "thread_1",
    projectId: "project_1",
    status: "active",
  });
  let events: Event[] = [request()];
  let connected = true;
  let sendFailure = false;
  let pendingInteraction = false;
  const sent: string[] = [];
  let host = createFakePluginHost({
    pluginId: "upgrade-resume",
    sdk: {
      threads: {
        listRunning: async () => [{ id: "thread_1", hostId: "host_1" }],
        get: async () => thread,
        interactions: {
          list: async () =>
            pendingInteraction
              ? [
                  {
                    id: "interaction_1",
                    threadId: "thread_1",
                    turnId: null,
                    status: "pending",
                    statusReason: null,
                    createdAt: 1,
                    resolvedAt: null,
                    origin: {
                      kind: "plugin",
                      pluginId: "test-form",
                      rendererId: "form",
                    },
                    payload: {
                      kind: "plugin",
                      title: "Confirm action",
                      data: {},
                    },
                    resolution: null,
                  },
                ]
              : [],
        },
        events: {
          list: async (args) => {
            if (Number(args.limit ?? 100) > 100)
              throw new Error("Thread event limit cannot exceed 100");
            let rows = events.filter(
              (event) =>
                (!args.types || args.types.includes(event.type)) &&
                (args.afterSeq === undefined ||
                  event.seq > Number(args.afterSeq)) &&
                (args.beforeSeq === undefined ||
                  event.seq < Number(args.beforeSeq)),
            );
            rows = [...rows].sort((a, b) =>
              args.order === "desc" ? b.seq - a.seq : a.seq - b.seq,
            );
            return rows.slice(0, Number(args.limit ?? 100));
          },
        },
        send: async (args) => {
          sent.push(args.threadId);
          if (sendFailure) throw new Error("Response lost after acceptance");
          events.push(request(events.at(-1)!.seq + 1, "req_continuation"));
          thread = { ...thread, status: "active" };
          return { ok: true, delivery: "sent" };
        },
      },
      hosts: {
        get: async () =>
          makeHostResponse({
            id: "host_1",
            status: connected ? "connected" : "disconnected",
          }),
      },
    },
  });
  plugin(host.bb);
  cleanups.push(() => host.harness.lifecycle.dispose());
  const command = (args: string[]) =>
    host.harness.behavior.runCli([...args, "--json"]);
  async function prepare() {
    const result = await command(["prepare"]);
    expect(result.exitCode).toBe(0);
  }
  function restart() {
    const store = new Store(host.bb.storage.database());
    const batch = store.load()!;
    store.save({ ...batch, bootId: "previous-server-process" });
  }
  return {
    ...host,
    sent,
    command,
    prepare,
    restart,
    reload: async () => {
      host = await host.harness.lifecycle.reload(plugin);
    },
    status: () => new Store(host.bb.storage.database()).load()!,
    setThread: (value: Partial<Thread>) => {
      thread = { ...thread, ...value };
    },
    setEvents: (value: Event[]) => {
      events = value;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    failSend: () => {
      sendFailure = true;
    },
    setPendingInteraction: (value: boolean) => {
      pendingInteraction = value;
    },
  };
}

describe("prepared upgrade recovery through the plugin CLI", () => {
  it("persists the snapshot across plugin reload without mistaking reload for a server restart", async () => {
    const app = await setup();
    await app.prepare();
    const snapshot = app.status();
    expect(snapshot.entries.map((entry) => entry.threadId)).toEqual([
      "thread_1",
    ]);
    await app.reload();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    await app.command(["resume"]);
    expect(app.status().id).toBe(snapshot.id);
    expect(app.status().state).toBe("armed");
    expect(app.sent).toEqual([]);
    expect((await app.command(["prepare"])).exitCode).toBe(1);
  });

  it("keeps the request and checkpoint consistent when another dispatch lands during prepare", async () => {
    const app = await setup();
    const old = request();
    const done = completion();
    const newer = request(3, "req_new");
    app.harness.inspection.sdk.stub(
      "threads.events.list",
      async (
        args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0],
      ) =>
        args.types?.length === 1
          ? args.beforeSeq === undefined
            ? [newer]
            : [old]
          : [done],
    );
    await app.prepare();
    expect(app.status().entries[0]).toMatchObject({
      requestId: "req_original",
      requestSeq: 1,
      checkpointSeq: 2,
    });
  });

  it("continues the original interrupted thread once after restart and machine reconnection", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    app.setConnected(false);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.detail).toContain("reconnect");
    app.setConnected(true);
    await Promise.all([app.command(["resume"]), app.command(["resume"])]);
    expect(app.sent).toEqual(["thread_1"]);
    expect(app.status().state).toBe("finished");
    expect(app.status().entries[0]!.state).toBe("resumed");
    const sends = app.harness.inspection.sdk.callsTo("threads.send");
    expect(sends[0]![0]).toMatchObject({
      threadId: "thread_1",
      mode: "queue-if-active",
    });
  });

  it("continues the pre-restart successor interrupted after the prepared turn completed", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "error" });
    app.setEvents([
      request(),
      completion(),
      request(3, "req_new", performance.timeOrigin - 2),
      accepted(4),
      completion(5, "interrupted", "turn_2"),
      interruption(6),
    ]);
    await app.command(["resume"]);
    expect(app.status().entries[0]!.state).toBe("resumed");
    expect(app.sent).toEqual(["thread_1"]);
    expect(
      app.harness.inspection.sdk.callsTo("threads.send")[0]![0],
    ).toMatchObject({
      pluginSubmission: { data: { requestId: "req_new" } },
    });
  });

  it("continues queued work drained into a turn before shutdown after that turn's provider exits", async () => {
    const app = await setup();
    app.setThread({ queuedMessageCount: 1 });
    await app.prepare();
    app.restart();
    app.setThread({ status: "error", queuedMessageCount: 0 });
    const drained = request(3, "req_new", performance.timeOrigin - 4);
    if (drained.type !== "client/turn/requested")
      throw new Error("Expected request");
    drained.data.target = { kind: "auto", expectedTurnId: null };
    app.setEvents([
      request(),
      completion(),
      drained,
      accepted(4, performance.timeOrigin - 3),
      completion(5, "failed", "turn_2"),
      processExit(6, performance.timeOrigin - 1, "turn_2"),
    ]);
    await app.command(["resume"]);
    expect(app.sent).toEqual(["thread_1"]);
    expect(app.status().entries[0]!.state).toBe("resumed");
  });

  it.each([
    {
      name: "the input is not accepted",
      events: [completion(4, "interrupted", "turn_1"), interruption(5)],
      state: "pending",
    },
    {
      name: "the input is accepted after restart",
      events: [
        accepted(4, performance.timeOrigin + 1),
        completion(5, "interrupted", "turn_2"),
        interruption(6),
      ],
      state: "skipped",
    },
    {
      name: "the provider exit belongs to the old turn",
      events: [accepted(4), processExit(5, performance.timeOrigin - 1)],
      state: "pending",
    },
    {
      name: "the daemon interruption belongs to the old turn",
      events: [
        accepted(4),
        completion(5, "interrupted", "turn_1"),
        interruption(6),
      ],
      state: "pending",
    },
    {
      name: "the successor completed",
      events: [accepted(4), completion(5, "completed", "turn_2")],
      state: "skipped",
    },
    {
      name: "the successor was manually stopped",
      events: [
        accepted(4),
        completion(5, "interrupted", "turn_2"),
        interruption(6, "manual-stop"),
      ],
      state: "skipped",
    },
  ])("does not send a continuation when $name", async ({ events, state }) => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "error" });
    app.setEvents([
      request(),
      completion(),
      request(3, "req_new", performance.timeOrigin - 2),
      ...events,
    ]);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe(state);
  });

  it("does not move the takeover boundary forward if the server restarts again", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    const store = new Store(app.bb.storage.database());
    const batch = store.load()!;
    store.save({
      ...batch,
      state: "recovering",
      recoveryBootAt: performance.timeOrigin - 10,
    });
    app.setThread({ status: "error" });
    app.setEvents([
      request(),
      request(2, "req_new", performance.timeOrigin - 5),
      accepted(3),
      completion(4, "interrupted", "turn_2"),
      interruption(5),
    ]);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe("skipped");
  });

  it("rechecks events after host readiness when a manual dispatch starts and settles during recovery", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    app.harness.inspection.sdk.stub("hosts.get", async () => {
      app.setEvents([
        request(),
        interruption(),
        request(3, "req_manual", Date.now()),
        completion(4, "completed", "turn_2"),
      ]);
      return makeHostResponse({ id: "host_1", status: "connected" });
    });
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    await app.command(["resume"]);
    expect(app.status().entries[0]!.state).toBe("skipped");
  });

  it.each([
    ["completed", [request(), completion()]],
    ["manually stopped", [request(), interruption(2, "manual-stop")]],
    [
      "already continued",
      [request(), interruption(), request(3, "req_new", Date.now())],
    ],
  ])("leaves a task alone when it was %s", async (_name, events) => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents(events);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe("skipped");
  });

  it.each([{ archivedAt: 1 }, { queuedMessageCount: 1 }])(
    "leaves archived threads and queued work alone: %j",
    async (change) => {
      const app = await setup();
      await app.prepare();
      app.restart();
      app.setThread({ ...change, status: "idle" });
      app.setEvents([request(), interruption()]);
      await app.command(["resume"]);
      expect(app.sent).toEqual([]);
      expect(app.status().entries[0]!.state).toBe("skipped");
    },
  );

  it.each([
    { reason: "an ordinary failed turn", events: [completion(2, "failed")] },
    { reason: "a provider exit after restart", events: [processExit()] },
  ])("does not continue after $reason", async ({ events }) => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "error" });
    app.setEvents([request(), ...events]);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe("pending");
  });

  it.each([
    { reason: "daemon restart", events: [interruption()], status: "idle" },
    {
      reason: "provider exit during shutdown",
      events: [
        completion(2, "failed"),
        processExit(3, performance.timeOrigin - 1),
      ],
      status: "error",
    },
  ] as const)(
    "automatically recovers after $reason",
    async ({ events, status }) => {
      const app = await setup();
      await app.prepare();
      app.restart();
      app.setThread({ status });
      app.setEvents([request(), ...events]);
      const service = app.harness.behavior.runService("upgrade-resume");
      try {
        await expect.poll(() => app.sent).toEqual(["thread_1"]);
      } finally {
        service.controller.abort();
        await service.done;
      }
      expect(app.status().entries[0]!.state).toBe("resumed");
    },
  );

  it("excludes approvals when preparing and preserves approvals encountered during recovery", async () => {
    const app = await setup();
    app.setPendingInteraction(true);
    await app.prepare();
    expect(app.status().entries).toEqual([]);
    app.setPendingInteraction(false);
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    app.setPendingInteraction(true);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe("skipped");
  });

  it("reads beyond the first event page before deciding a task can be resumed", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([
      request(),
      ...Array.from({ length: 200 }, (_, i) => interruption(i + 2)),
      interruption(202, "manual-stop"),
    ]);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe("skipped");
  });

  it("does not automatically resend when the send response was lost", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    app.failSend();
    await app.command(["resume"]);
    await app.reload();
    await app.command(["resume"]);
    expect(app.sent).toEqual(["thread_1"]);
    expect(app.status().entries[0]!.state).toBe("uncertain");
  });

  it("keeps a persisted in-flight dispatch uncertain instead of replaying it after restart", async () => {
    const app = await setup();
    await app.prepare();
    const store = new Store(app.bb.storage.database());
    const batch = store.load()!;
    batch.entries[0]!.state = "sending";
    store.save(batch);
    app.restart();
    await app.command(["resume"]);
    expect(app.status().entries[0]!.state).toBe("uncertain");
    expect(app.sent).toEqual([]);
  });

  it("honors cancellation and project scoping", async () => {
    const app = await setup();
    const result = await app.command([
      "prepare",
      "--project",
      "another_project",
    ]);
    expect(result.exitCode).toBe(0);
    expect(app.status().entries).toEqual([]);
    await app.prepare();
    await app.command(["cancel"]);
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().state).toBe("cancelled");
  });

  it("cancels pending dispatch while recovery is checking machine readiness", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    let releaseHost!: () => void;
    let reachedHost!: () => void;
    const checkingHost = new Promise<void>((resolve) => {
      reachedHost = resolve;
    });
    const hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    app.harness.inspection.sdk.stub("hosts.get", async () => {
      reachedHost();
      await hostGate;
      return makeHostResponse({ id: "host_1", status: "connected" });
    });
    const resuming = app.command(["resume"]);
    await checkingHost;
    const cancelling = app.command(["cancel"]);
    releaseHost();
    await Promise.all([resuming, cancelling]);
    expect(app.sent).toEqual([]);
    expect(app.status().state).toBe("cancelled");
  });

  it("keeps private BB imports out of the standalone package", () => {
    const scan = experimental_scanPublicSdkOnly(
      fileURLToPath(new URL("..", import.meta.url)),
      { allow: [/^better-sqlite3$/, /^vitest\/config$/] },
    );
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
