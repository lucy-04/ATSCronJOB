import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const BOT_TOKEN_PARAM = "/ats-poller/telegram-bot-token";
const CHAT_ID_PARAM = "/ats-poller/telegram-chat-id";

async function getParam(client: SSMClient, name: string): Promise<string> {
  const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is missing a value`);
  return value;
}

/** Read the Telegram bot token + chat id from SSM Parameter Store (SecureString). */
export async function getTelegramCreds(client: SSMClient = new SSMClient({})): Promise<{ token: string; chatId: string }> {
  const [token, chatId] = await Promise.all([
    getParam(client, BOT_TOKEN_PARAM),
    getParam(client, CHAT_ID_PARAM),
  ]);
  return { token, chatId };
}
