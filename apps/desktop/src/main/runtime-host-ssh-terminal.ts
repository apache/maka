import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import {
  openRuntimeHostSshTunnel,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
  type RuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
} from '@maka/runtime-host/client';
import type {
  DesktopRuntimeHostSshTerminalEvent,
  DesktopRuntimeHostSshTerminalSnapshot,
} from '../preload/bridge-contract.js';

interface ActiveTerminal {
  readonly sessionId: string;
  readonly pty: IPty;
  readonly exited: Promise<void>;
  revealTimer: ReturnType<typeof setTimeout> | undefined;
  phase: 'connecting' | 'connected';
  revealed: boolean;
  dismissed: boolean;
  output: string;
}

const TERMINAL_REVEAL_DELAY_MS = 500;
const TERMINAL_OUTPUT_MAX = 64 * 1024;

export function createDesktopRuntimeHostSshTerminal(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly send: (channel: string, event: DesktopRuntimeHostSshTerminalEvent) => void;
  readonly spawnPty?: typeof spawnPty;
  readonly openSshTunnel?: typeof openRuntimeHostSshTunnel;
  readonly revealDelayMs?: number;
}): {
  openSshTunnel(input: RuntimeHostSshTunnelInput): Promise<RuntimeHostSshTunnel>;
  close(): Promise<void>;
} {
  let active: ActiveTerminal | undefined;
  let revision = 0;
  let presentation: Exclude<DesktopRuntimeHostSshTerminalSnapshot, { kind: 'idle' }> | undefined;
  const spawnProcess: RuntimeHostSshProcessFactory = ({ executable, args, interaction }) => {
    if (interaction !== 'terminal') {
      throw new Error('Desktop SSH terminal received a non-interactive launch');
    }
    if (active) throw new Error('Another Runtime Host SSH terminal is already active');
    const sessionId = randomUUID();
    const pty = (input.spawnPty ?? spawnPty)(executable, [...args], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: homedir(),
      env: sshEnvironment(),
    });
    let resolveExit: ((value: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void) | undefined;
    const exited = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => {
      resolveExit = resolve;
    });
    const terminal: ActiveTerminal = {
      sessionId,
      pty,
      exited: exited.then(() => undefined),
      revealTimer: undefined,
      phase: 'connecting',
      revealed: false,
      dismissed: false,
      output: '',
    };
    active = terminal;
    const reveal = () => {
      if (
        active !== terminal ||
        terminal.phase !== 'connecting' ||
        terminal.revealed ||
        terminal.dismissed
      ) {
        return;
      }
      terminal.revealed = true;
      revision += 1;
      presentation = { kind: 'connecting', revision, sessionId, output: terminal.output };
      input.send('runtime-host-ssh-terminal:event', { kind: 'opened', revision, sessionId });
    };
    terminal.revealTimer = setTimeout(reveal, input.revealDelayMs ?? TERMINAL_REVEAL_DELAY_MS);
    pty.onData((data) => {
      if (active !== terminal || terminal.phase !== 'connecting' || terminal.dismissed) return;
      terminal.output = `${terminal.output}${data}`.slice(-TERMINAL_OUTPUT_MAX);
      reveal();
      revision += 1;
      if (presentation?.kind === 'connecting' && presentation.sessionId === sessionId) {
        presentation = { ...presentation, revision, output: terminal.output };
      }
      input.send('runtime-host-ssh-terminal:event', { kind: 'data', revision, sessionId, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (terminal.revealTimer !== undefined) clearTimeout(terminal.revealTimer);
      if (active === terminal) active = undefined;
      if (terminal.revealed && terminal.phase === 'connecting' && !terminal.dismissed) {
        revision += 1;
        presentation = {
          kind: 'closed',
          revision,
          sessionId,
          output: terminal.output,
          code: exitCode,
          signal: signal === 0 ? null : String(signal),
        };
        input.send('runtime-host-ssh-terminal:event', {
          kind: 'closed',
          revision,
          sessionId,
          code: exitCode,
          signal: signal === 0 ? null : String(signal),
        });
      }
      resolveExit?.({ code: exitCode, signal: null });
    });
    return {
      pid: pty.pid,
      exited,
      kill: (signal) => {
        try {
          pty.kill(signal);
        } catch {
          // The exit event is the authority; a concurrent exit makes kill a no-op.
        }
      },
    } satisfies RuntimeHostSshProcess;
  };

  const channels = [
    'runtime-host-ssh-terminal:getSnapshot',
    'runtime-host-ssh-terminal:write',
    'runtime-host-ssh-terminal:resize',
    'runtime-host-ssh-terminal:cancel',
  ] as const;
  input.ipcMain.handle(channels[0], () => presentation ?? { kind: 'idle', revision });
  input.ipcMain.handle(channels[1], (_event, request: { sessionId: string; data: string }) => {
    const terminal = findConnecting(active, request.sessionId);
    if (!terminal) return;
    if (typeof request.data !== 'string' || request.data.length === 0 || request.data.length > 8_192) {
      throw new Error('Runtime Host SSH terminal input is invalid');
    }
    terminal.pty.write(request.data);
  });
  input.ipcMain.handle(
    channels[2],
    (_event, request: { sessionId: string; cols: number; rows: number }) => {
      const terminal = findConnecting(active, request.sessionId);
      if (!terminal) return;
      if (
        !Number.isInteger(request.cols) ||
        request.cols < 1 ||
        request.cols > 500 ||
        !Number.isInteger(request.rows) ||
        request.rows < 1 ||
        request.rows > 200
      ) {
        throw new Error('Runtime Host SSH terminal size is invalid');
      }
      terminal.pty.resize(request.cols, request.rows);
    },
  );
  input.ipcMain.handle(channels[3], (_event, sessionId: string) => {
    if (presentation?.sessionId === sessionId) {
      presentation = undefined;
      revision += 1;
    }
    const terminal = findActive(active, sessionId);
    if (!terminal) return;
    terminal.dismissed = true;
    try {
      terminal.pty.kill();
    } catch {
      // The process may have exited between validation and cancellation.
    }
  });

  return {
    openSshTunnel: async (tunnelInput) => {
      const openSshTunnel = input.openSshTunnel ?? openRuntimeHostSshTunnel;
      if (tunnelInput.interaction !== 'terminal') return openSshTunnel(tunnelInput);
      const tunnel = await openSshTunnel(tunnelInput, { spawnProcess });
      const terminal = active;
      if (terminal) {
        terminal.phase = 'connected';
        presentation = undefined;
        revision += 1;
        if (terminal.revealTimer !== undefined) {
          clearTimeout(terminal.revealTimer);
          terminal.revealTimer = undefined;
        }
        if (terminal.revealed) {
          input.send('runtime-host-ssh-terminal:event', {
            kind: 'connected',
            revision,
            sessionId: terminal.sessionId,
          });
        }
      }
      return tunnel;
    },
    close: async () => {
      for (const channel of channels) input.ipcMain.removeHandler(channel);
      const terminal = active;
      if (!terminal) return;
      active = undefined;
      presentation = undefined;
      terminal.dismissed = true;
      if (terminal.revealTimer !== undefined) clearTimeout(terminal.revealTimer);
      try {
        terminal.pty.kill();
      } catch {}
      await terminal.exited.catch(() => undefined);
    },
  };
}

function findConnecting(
  active: ActiveTerminal | undefined,
  sessionId: string,
): ActiveTerminal | undefined {
  return active?.sessionId === sessionId && active.phase === 'connecting' ? active : undefined;
}

function findActive(
  active: ActiveTerminal | undefined,
  sessionId: string,
): ActiveTerminal | undefined {
  return active?.sessionId === sessionId ? active : undefined;
}

function sshEnvironment(): Record<string, string> {
  const allowed = new Set([
    'APPDATA',
    'COMSPEC',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'PATH',
    'PATHEXT',
    'SHELL',
    'SSH_AUTH_SOCK',
    'SYSTEMROOT',
    'TEMP',
    'TERM',
    'TMP',
    'USER',
    'USERPROFILE',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      allowed.has(key.toUpperCase()) && value !== undefined ? [[key, value]] : [],
    ),
  );
}
