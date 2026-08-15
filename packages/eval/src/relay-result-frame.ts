import { createHash } from 'node:crypto';

// Keep the complete record below Linux PIPE_BUF so merged Docker stdout/stderr
// cannot interleave inside an otherwise valid result frame.
const RESULT_PAYLOAD_LIMIT_BYTES = 2 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

export function takeRelayResultToken(): string {
  const token = process.env.MAKA_EVAL_RESULT_TOKEN;
  delete process.env.MAKA_EVAL_RESULT_TOKEN;
  if (!token || !TOKEN_PATTERN.test(token)) throw new Error('relay result token is invalid');
  return token;
}

export function writeRelayResult(token: string, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength > RESULT_PAYLOAD_LIMIT_BYTES) {
    throw new Error('relay result exceeds the payload limit');
  }
  const digest = createHash('sha256').update(payload).digest('hex');
  process.stdout.write(
    `MAKA-EVAL-RESULT-V1 ${token} ${payload.byteLength} ${digest} ${payload.toString('base64url')}\n`,
  );
}
