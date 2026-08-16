import { createDecipheriv, randomBytes } from 'node:crypto';
import { proxiedFetch } from '@maka/runtime/bots';

const QQ_BIND_BASE_URL = 'https://q.qq.com';
const REQUEST_TIMEOUT_MS = 10_000;

interface QQBindEnvelope {
  retcode?: unknown;
  msg?: unknown;
  data?: Record<string, unknown>;
}

export interface QQBindTask {
  taskId: string;
  decryptionKey: string;
  verificationUrl: string;
}

export type QQBindPollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'confirmed'; appId: string; appSecret: string };

/**
 * Tencent's QQ Bot bind-task protocol returns an encrypted AppSecret after the
 * user scans and confirms in mobile QQ. The key never leaves the main process.
 */
export async function createQQBindTask(signal: AbortSignal): Promise<QQBindTask> {
  const decryptionKey = randomBytes(32).toString('base64');
  const json = await postQQBind('/lite/create_bind_task', { key: decryptionKey }, signal);
  const taskId = json.data?.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('QQ bind task response is missing task_id');
  }
  const verificationUrl = new URL('/qqbot/openclaw/connect.html', QQ_BIND_BASE_URL);
  verificationUrl.searchParams.set('task_id', taskId);
  verificationUrl.searchParams.set('source', 'maka');
  verificationUrl.searchParams.set('_wv', '2');
  return { taskId, decryptionKey, verificationUrl: verificationUrl.toString() };
}

export async function pollQQBindTask(
  taskId: string,
  decryptionKey: string,
  signal: AbortSignal,
): Promise<QQBindPollResult> {
  const json = await postQQBind('/lite/poll_bind_result', { task_id: taskId }, signal);
  const status = json.data?.status;
  if (status === 3) return { status: 'expired' };
  if (status !== 2) return { status: 'pending' };

  const appId = json.data?.bot_appid;
  const encryptedSecret = json.data?.bot_encrypt_secret;
  if (
    (typeof appId !== 'string' && typeof appId !== 'number') ||
    typeof encryptedSecret !== 'string' ||
    encryptedSecret.length === 0
  ) {
    throw new Error('QQ bind result is missing bot credentials');
  }
  return {
    status: 'confirmed',
    appId: String(appId),
    appSecret: decryptQQBotSecret(encryptedSecret, decryptionKey),
  };
}

export function decryptQQBotSecret(encryptedSecret: string, decryptionKey: string): string {
  const payload = Buffer.from(encryptedSecret, 'base64');
  const key = Buffer.from(decryptionKey, 'base64');
  if (key.length !== 32 || payload.length <= 28) {
    throw new Error('QQ bind result contains an invalid encrypted secret');
  }
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function postQQBind(
  path: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<QQBindEnvelope> {
  const response = await proxiedFetch(new URL(path, QQ_BIND_BASE_URL).toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`QQ bind request failed with HTTP ${response.status}`);
  const json = (await response.json()) as QQBindEnvelope;
  if (json.retcode !== 0) {
    throw new Error(
      typeof json.msg === 'string' && json.msg.length > 0
        ? `QQ bind request failed: ${json.msg}`
        : 'QQ bind request failed',
    );
  }
  return json;
}
