import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { getTelegramCreds } from "../src/aws/secrets.js";

const ssmMock = mockClient(SSMClient);
beforeEach(() => ssmMock.reset());

describe("getTelegramCreds", () => {
  it("reads both SecureString params with decryption", async () => {
    ssmMock.on(GetParameterCommand, { Name: "/ats-poller/telegram-bot-token" }).resolves({ Parameter: { Value: "TOKEN" } });
    ssmMock.on(GetParameterCommand, { Name: "/ats-poller/telegram-chat-id" }).resolves({ Parameter: { Value: "CHAT" } });
    const creds = await getTelegramCreds(ssmMock as unknown as SSMClient);
    expect(creds).toEqual({ token: "TOKEN", chatId: "CHAT" });
    const call = ssmMock.commandCalls(GetParameterCommand)[0]!;
    expect(call.args[0].input.WithDecryption).toBe(true);
  });

  it("throws if a parameter is missing a value", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: {} });
    await expect(getTelegramCreds(ssmMock as unknown as SSMClient)).rejects.toThrow(/missing/i);
  });
});
