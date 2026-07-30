export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err(code: string, message: string, details?: unknown): Result<never> {
  return { ok: false, error: { code, message, details } };
}

export async function tryResult<T>(fn: () => Promise<T>, errorCode: string): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(errorCode, message, error);
  }
}
