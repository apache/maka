import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { WASocket } from 'baileys';

export type WhatsAppQrLoginPollResult =
  | { status: 'pending'; qrValue?: string }
  | { status: 'confirmed'; identity?: { id?: string; displayName?: string } }
  | { status: 'error'; error: string };

export interface WhatsAppQrLogin {
  readonly initialQrValue: string;
  poll(): Promise<WhatsAppQrLoginPollResult>;
  cancel(): void;
}

/**
 * Starts an isolated WhatsApp multi-device pairing socket. Auth material is
 * written only beneath `authDir`; the renderer receives only the QR payload.
 */
export async function startWhatsAppQrLogin(
  authDir: string,
  signal: AbortSignal,
): Promise<WhatsAppQrLogin> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const parentDir = dirname(authDir);
  const stagingDir = join(parentDir, `.${basename(authDir)}.pairing-${randomUUID()}`);
  await mkdir(parentDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
  } = await import('baileys');
  const { state, saveCreds } = await useMultiFileAuthState(stagingDir);
  const version = await fetchLatestBaileysVersion()
    .then((result) => result.version)
    .catch(() => [2, 3000, 1015901] as [number, number, number]);
  const logger = silentBaileysLogger();
  const socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ['Maka', 'Desktop', '0.1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 30_000,
  });

  let status: WhatsAppQrLoginPollResult = { status: 'pending' };
  let latestSave = Promise.resolve();
  let settled = false;
  let cancelled = false;
  let connected = false;
  let connectedIdentity: { id?: string; displayName?: string } | undefined;
  let promotion: Promise<void> | undefined;
  let resolveInitialQr: ((value: string) => void) | undefined;
  let rejectInitialQr: ((error: Error) => void) | undefined;
  const initialQr = new Promise<string>((resolve, reject) => {
    resolveInitialQr = resolve;
    rejectInitialQr = reject;
  });

  socket.ev.on('creds.update', () => {
    latestSave = latestSave.then(saveCreds, saveCreds);
  });
  socket.ev.on('connection.update', (update) => {
    if (update.qr) {
      status = { status: 'pending', qrValue: update.qr };
      if (!settled) {
        settled = true;
        resolveInitialQr?.(update.qr);
      }
    }
    if (update.connection === 'open') {
      connected = true;
      connectedIdentity = socket.user
        ? {
            id: socket.user.id,
            ...(socket.user.name ? { displayName: socket.user.name } : {}),
          }
        : undefined;
      if (!settled) {
        settled = true;
        rejectInitialQr?.(new Error('WhatsApp session connected without a QR challenge'));
      }
    } else if (
      update.connection === 'close' &&
      !connected &&
      status.status !== 'confirmed' &&
      !signal.aborted
    ) {
      const error = connectionErrorMessage(update.lastDisconnect?.error);
      status = { status: 'error', error };
      if (!settled) {
        settled = true;
        rejectInitialQr?.(new Error(error));
      }
    }
  });

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (!settled) {
      settled = true;
      rejectInitialQr?.(new DOMException('Aborted', 'AbortError'));
    }
    try {
      socket.end(new Error('WhatsApp QR login cancelled'));
    } catch {
      // The transport may already be closed after a successful handoff.
    }
    if (!promotion) void rm(stagingDir, { recursive: true, force: true });
  };
  signal.addEventListener('abort', cancel, { once: true });

  let initialQrValue: string;
  try {
    initialQrValue = await initialQr;
  } catch (error) {
    cancel();
    throw error;
  }
  return {
    initialQrValue,
    async poll() {
      if (status.status === 'confirmed') return status;
      if (connected) {
        if (signal.aborted || cancelled) {
          throw new DOMException('Aborted', 'AbortError');
        }
        promotion ??= latestSave.then(() => promoteWhatsAppAuthState(stagingDir, authDir));
        await promotion;
        status = {
          status: 'confirmed',
          ...(connectedIdentity ? { identity: connectedIdentity } : {}),
        };
        cancel();
      }
      return status;
    },
    cancel,
  };
}

/**
 * Replace the active session only after the new device link is confirmed.
 * A failed or cancelled scan therefore cannot destroy a working session.
 */
export async function promoteWhatsAppAuthState(stagingDir: string, authDir: string): Promise<void> {
  const parentDir = dirname(authDir);
  const backupDir = join(parentDir, `.${basename(authDir)}.backup-${randomUUID()}`);
  let hasBackup = false;
  try {
    await rename(authDir, backupDir);
    hasBackup = true;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  try {
    await rename(stagingDir, authDir);
  } catch (error) {
    if (hasBackup) await rename(backupDir, authDir).catch(() => {});
    throw error;
  }
  if (hasBackup) await rm(backupDir, { recursive: true, force: true }).catch(() => {});
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'WhatsApp pairing connection closed';
}

function silentBaileysLogger() {
  const logger = {
    level: 'silent',
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  };
  return logger;
}

export function closeWhatsAppSocket(socket: WASocket, reason: string): void {
  try {
    socket.end(new Error(reason));
  } catch {
    // best-effort shutdown
  }
}
