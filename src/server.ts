import { setTimeout } from "node:timers/promises";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { Recovery, errorMessage } from "./recovery.js";
import { migrations, Store, type Batch } from "./store.js";

export default function plugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const recovery = new Recovery(bb, new Store(db));
  bb.cli.register(
    defineCli({
      name: "upgrade-resume",
      summary:
        "Record running work before a BB upgrade and continue interrupted threads after restart.",
      commands: {
        prepare: cliCommand({
          summary:
            "Record currently active threads. Does not stop threads or upgrade BB.",
          options: {
            project: {
              type: "string",
              description: "Only record threads in this project ID.",
            },
            json: {
              type: "boolean",
              description: "Print the recovery batch as JSON.",
            },
          },
          async run(input) {
            return result(
              await recovery.prepare(input.options.project),
              input.options.json,
            );
          },
        }),
        status: cliCommand({
          summary: "Show the latest recovery batch and every thread outcome.",
          options: { json: { type: "boolean", description: "Print JSON." } },
          async run(input) {
            return result(recovery.status(), input.options.json);
          },
        }),
        cancel: cliCommand({
          summary:
            "Cancel pending continuations in the current recovery batch.",
          options: { json: { type: "boolean", description: "Print JSON." } },
          async run(input) {
            return result(await recovery.cancel(), input.options.json);
          },
        }),
        resume: cliCommand({
          summary:
            "Check pending recovery now, after the BB server process has restarted.",
          options: { json: { type: "boolean", description: "Print JSON." } },
          async run(input, ctx) {
            return result(
              await recovery.sweep(ctx.signal ?? new AbortController().signal),
              input.options.json,
            );
          },
        }),
      },
    }),
  );
  bb.background.service("upgrade-resume", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await recovery.sweep(signal);
        } catch (error) {
          bb.log.error(`Upgrade recovery failed: ${errorMessage(error)}`);
        }
        try {
          await setTimeout(5000, undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    },
  });
}

function result(value: Batch | null, json: boolean | undefined) {
  const stdout = json
    ? JSON.stringify(value, null, 2)
    : value
      ? [
          `Batch ${value.id}: ${value.state} (${value.entries.length} threads)`,
          ...value.entries.map(
            (entry) => `${entry.threadId}: ${entry.state} — ${entry.detail}`,
          ),
        ].join("\n")
      : "No recovery batch. Run bb upgrade-resume prepare before upgrading BB.";
  return { exitCode: 0, stdout };
}
