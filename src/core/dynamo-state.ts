import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Job } from "./types.js";
import type { StateStore } from "./state.js";

const DAY_S = 86_400;
const SOURCE_MARKER = "#SOURCE";

export interface DynamoStoreOptions {
  tableName: string;
  /** Injectable for tests; defaults to a real DocumentClient. */
  client?: DynamoDBDocumentClient;
  /** Epoch-ms clock, injectable for deterministic tests. */
  now?: () => number;
  /** Prune window in days (drives the TTL). Default 14. */
  graceDays?: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function createDynamoStore(opts: DynamoStoreOptions): StateStore {
  const client = opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const table = opts.tableName;
  const now = opts.now ?? Date.now;
  const graceDays = opts.graceDays ?? 14;

  function ttl(nowMs: number): number {
    return Math.floor(nowMs / 1000) + graceDays * DAY_S;
  }

  /** BatchWrite all items, retrying UnprocessedItems until drained. */
  async function batchWrite(items: Record<string, unknown>[]): Promise<void> {
    for (const group of chunk(items, 25)) {
      let requestItems: Record<string, unknown[]> = {
        [table]: group.map((Item) => ({ PutRequest: { Item } })),
      };
      // Retry unprocessed items a bounded number of times.
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await client.send(new BatchWriteCommand({ RequestItems: requestItems as never }));
        const unprocessed = res.UnprocessedItems?.[table];
        if (!unprocessed || unprocessed.length === 0) break;
        requestItems = { [table]: unprocessed as unknown[] };
      }
    }
  }

  /** Return the set of sk (job_id) values already stored for `source`, among the given ids. */
  async function existingIds(source: string, ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const group of chunk(ids, 100)) {
      let keys = group.map((id) => ({ pk: source, sk: id }));
      for (let attempt = 0; attempt < 5 && keys.length > 0; attempt++) {
        const res = await client.send(
          new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } as never }),
        );
        for (const item of (res.Responses?.[table] ?? []) as Array<{ sk: string }>) found.add(item.sk);
        const un = (res.UnprocessedKeys?.[table] as { Keys?: Array<{ sk: string }> } | undefined)?.Keys;
        keys = (un as typeof keys) ?? [];
      }
    }
    return found;
  }

  return {
    async diffAndRecord(source: string, jobs: Job[]): Promise<Job[]> {
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const exp = ttl(nowMs);

      const markerRes = await client.send(
        new GetCommand({ TableName: table, Key: { pk: source, sk: SOURCE_MARKER } }),
      );
      const isNewSource = markerRes.Item === undefined;

      const marker = { pk: source, sk: SOURCE_MARKER, last_seen: nowIso, expires_at: exp };
      const jobItem = (j: Job) => ({ pk: source, sk: j.id, first_seen: nowIso, last_seen: nowIso, expires_at: exp });

      if (isNewSource) {
        // Seed silently: record everything, notify nothing.
        await batchWrite([marker, ...jobs.map(jobItem)]);
        return [];
      }
      if (jobs.length === 0) {
        // Nothing to diff or record; leave the marker/TTL untouched.
        return [];
      }
      const existing = await existingIds(source, jobs.map((j) => j.id));
      const newJobs = jobs.filter((j) => !existing.has(j.id));
      await batchWrite([marker, ...jobs.map(jobItem)]);
      return newJobs;
    },

    // DynamoDB TTL deletes items not refreshed within graceDays; nothing to do.
    async prune(): Promise<number> {
      return 0;
    },

    async close(): Promise<void> {
      // DocumentClient needs no explicit teardown.
    },
  };
}
