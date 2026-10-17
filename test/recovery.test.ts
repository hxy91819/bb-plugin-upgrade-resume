import { afterEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
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

function request(seq = 1, requestId = "req_original"): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt: 1,
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

function completion(seq = 2): Event {
  return {
    id: `event_${seq}`,
    threadId: "thread_1",
    seq,
    createdAt: Date.now(),
    scope: { kind: "turn", turnId: "turn_1" },
    type: "turn/completed",
    data: { providerThreadId: "provider_1", status: "completed" },
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
                  event.seq > Number(args.afterSeq)),
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

  it.each([
    ["completed", [request(), completion()]],
    ["manually stopped", [request(), interruption(2, "manual-stop")]],
    ["already continued", [request(), interruption(), request(3, "req_new")]],
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

  it("does not turn an unrelated failure into an upgrade continuation", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "error" });
    await app.command(["resume"]);
    expect(app.sent).toEqual([]);
    expect(app.status().entries[0]!.state).toBe("pending");
  });

  it("runs recovery automatically when its background service starts", async () => {
    const app = await setup();
    await app.prepare();
    app.restart();
    app.setThread({ status: "idle" });
    app.setEvents([request(), interruption()]);
    const service = app.harness.behavior.runService("upgrade-resume");
    try {
      await expect.poll(() => app.sent).toEqual(["thread_1"]);
    } finally {
      service.controller.abort();
      await service.done;
    }
    expect(app.status().entries[0]!.state).toBe("resumed");
  });

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
