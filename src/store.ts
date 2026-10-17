import type Database from "better-sqlite3";
import { z } from "zod";

const entrySchema = z.object({
  threadId: z.string().min(1),
  hostId: z.string().nullable(),
  requestId: z.string().min(1),
  requestSeq: z.number().int().nonnegative(),
  checkpointSeq: z.number().int().nonnegative(),
  state: z.enum(["pending", "sending", "resumed", "skipped", "uncertain"]),
  detail: z.string(),
});

const batchSchema = z.object({
  id: z.string().min(1),
  bootId: z.string().min(1),
  preparedAt: z.number().int().nonnegative(),
  state: z.enum(["armed", "recovering", "finished", "cancelled"]),
  entries: z.array(entrySchema),
});

export type Entry = z.infer<typeof entrySchema>;
export type Batch = z.infer<typeof batchSchema>;

export const migrations = [
  "CREATE TABLE recovery_batch (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
];

export class Store {
  constructor(private readonly db: Database.Database) {}

  load(): Batch | null {
    const row = z
      .object({ payload: z.string() })
      .optional()
      .parse(
        this.db
          .prepare("SELECT payload FROM recovery_batch WHERE singleton = 1")
          .get(),
      );
    return row ? batchSchema.parse(JSON.parse(row.payload)) : null;
  }

  save(batch: Batch): void {
    this.db
      .prepare(
        "INSERT INTO recovery_batch (singleton, payload) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload",
      )
      .run(JSON.stringify(batch));
  }
}
