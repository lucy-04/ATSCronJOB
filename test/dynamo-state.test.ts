import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoStore } from "../src/core/dynamo-state.js";
import type { Job } from "../src/core/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = "test-table";
const FIXED_NOW = 1_700_000_000_000; // fixed epoch ms
function job(id: string): Job { return { id, title: id, url: "https://x/" + id, location: "Remote" }; }
function store() {
  return createDynamoStore({ tableName: TABLE, client: ddbMock as unknown as DynamoDBDocumentClient, now: () => FIXED_NOW, graceDays: 14 });
}

beforeEach(() => ddbMock.reset());

describe("createDynamoStore", () => {
  it("seeds a new source silently (no new jobs) and writes a #SOURCE marker + job rows", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // marker absent -> new source
    ddbMock.on(BatchWriteCommand).resolves({});
    const result = await store().diffAndRecord("greenhouse:acme", [job("1"), job("2")]);
    expect(result).toEqual([]); // seed-silently
    const writes = ddbMock.commandCalls(BatchWriteCommand);
    expect(writes.length).toBeGreaterThan(0);
    const written = writes.flatMap((c) => (c.args[0].input.RequestItems![TABLE] ?? []).map((r: any) => r.PutRequest.Item));
    expect(written.some((i) => i.sk === "#SOURCE")).toBe(true);
    expect(written.filter((i) => i.sk !== "#SOURCE").map((i) => i.sk).sort()).toEqual(["1", "2"]);
    // TTL set to now + 14d (epoch seconds)
    const expected = Math.floor(FIXED_NOW / 1000) + 14 * 86400;
    expect(written.every((i) => i.expires_at === expected)).toBe(true);
  });

  it("returns only jobs not already seen on a subsequent run", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "greenhouse:acme", sk: "#SOURCE" } }); // marker present
    // job "1" already exists; "2" and "3" are new
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [{ pk: "greenhouse:acme", sk: "1" }] } });
    ddbMock.on(BatchWriteCommand).resolves({});
    const result = await store().diffAndRecord("greenhouse:acme", [job("1"), job("2"), job("3")]);
    expect(result.map((j) => j.id).sort()).toEqual(["2", "3"]);
  });

  it("prune is a no-op (DynamoDB TTL handles expiry)", async () => {
    expect(await store().prune(14, ["greenhouse:acme"])).toBe(0);
    expect(ddbMock.commandCalls(BatchWriteCommand).length).toBe(0);
  });

  it("returns [] for an empty job list without writing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "x", sk: "#SOURCE" } });
    const result = await store().diffAndRecord("greenhouse:acme", []);
    expect(result).toEqual([]);
  });
});
