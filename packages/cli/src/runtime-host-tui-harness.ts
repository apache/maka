#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PermissionMode } from '@maka/core/permission';
import type { ProviderType } from '@maka/core/llm-connections';
import { SessionActivityRegistry } from '@maka/runtime';
import {
  connectOrSpawnExecutionRuntimeHostHarness,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ConnectionCatalogHeaderItem,
  type ConnectionCatalogQueryResult,
} from '@maka/runtime-host/protocol';
import { createHostMakaSessionDriver } from './host-session-driver.js';
import { runMakaPiTui, type MakaPiTuiGoalLifecycle } from './pi-tui-runner.js';

interface HarnessOptions {
  readonly rootPath: string;
  readonly cwd: string;
  readonly connectionSlug?: string;
  readonly model?: string;
  readonly resumeSessionId?: string;
  readonly permissionMode: PermissionMode;
}

interface HarnessTarget {
  readonly connectionSlug: string;
  readonly model: string;
  readonly providerType?: ProviderType;
}

export async function runRuntimeHostTuiHarness(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseHarnessOptions(argv);
  const connected = await connectOrSpawnExecutionRuntimeHostHarness({
    rootPath: options.rootPath,
    surface: 'tui',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  if (connected.kind !== 'connected') {
    throw new Error(`Unable to connect to the isolated Runtime Host: ${connected.kind}`);
  }
  const { connection } = connected;
  try {
    await waitForRuntimeHostReady(connection);
    const target = await resolveHarnessTarget(connection, options);
    const driver = createHostMakaSessionDriver({
      connection,
      cwd: options.cwd,
      llmConnectionSlug: target.connectionSlug,
      model: target.model,
      permissionMode: options.permissionMode,
    });
    await runMakaPiTui({
      driver,
      title: 'Maka Runtime Host Harness',
      cwd: options.cwd,
      model: target.model,
      connectionSlug: target.connectionSlug,
      providerType: target.providerType,
      permissionMode: options.permissionMode,
      goalLifecycle: createHarnessGoalLifecycle(),
      ...(options.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: options.resumeSessionId }),
    });
  } finally {
    await connection.close();
  }
}

async function waitForRuntimeHostReady(connection: RuntimeHostConnection): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (true) {
    const status = await connection.status(5_000);
    if (status.state === 'ready') return;
    if (status.state === 'draining') {
      throw new Error('The isolated Runtime Host began draining before it became ready');
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the isolated Runtime Host to become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function resolveHarnessTarget(
  connection: RuntimeHostConnection,
  options: HarnessOptions,
): Promise<HarnessTarget> {
  if (options.resumeSessionId) {
    const result = await connection.request('session.catalog.query', {
      kind: 'get',
      sessionId: options.resumeSessionId,
    });
    if (result.kind !== 'session' || result.session === null || 'kind' in result.session) {
      throw new Error(`Resume Session is unavailable: ${options.resumeSessionId}`);
    }
    return {
      connectionSlug: result.session.llmConnectionSlug,
      model: result.session.model,
    };
  }
  if (options.connectionSlug && options.model) {
    return {
      connectionSlug: options.connectionSlug,
      model: options.model,
    };
  }
  if (options.connectionSlug || options.model) {
    throw new Error('--connection and --model must be provided together');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const initial = await connection.request('connection.catalog.query', { kind: 'start' });
    if (initial.kind !== 'page') {
      throw new Error('Runtime Host returned an invalid Connection catalog start');
    }
    const revision = initial.revision;
    const defaultTarget = initial.defaultTarget;
    if (!defaultTarget) {
      throw new Error('The isolated Runtime Host root has no default model target');
    }
    const headers = new Map<number, ConnectionCatalogHeaderItem>();
    let page: Extract<ConnectionCatalogQueryResult, { kind: 'page' }> = initial;
    let restart = false;
    while (true) {
      for (const item of page.items) {
        if (item.kind === 'connection') headers.set(item.connectionIndex, item);
      }
      const target = [...headers.values()].find(
        (header) => header.connectionId === defaultTarget.connectionId,
      );
      if (target) {
        return {
          connectionSlug: target.slug,
          model: defaultTarget.modelId,
          providerType: target.providerType,
        };
      }
      if (page.nextCursor === null) {
        throw new Error('Default Runtime Host connection is absent from its catalog');
      }
      const continuation: ConnectionCatalogQueryResult = await connection.request(
        'connection.catalog.query',
        {
          kind: 'continue',
          revision,
          cursor: page.nextCursor,
        },
      );
      if (continuation.kind === 'revision_changed') {
        restart = true;
        break;
      }
      page = continuation;
    }
    if (!restart) break;
  }
  throw new Error('Connection catalog kept changing while it was read');
}

function createHarnessGoalLifecycle(): MakaPiTuiGoalLifecycle {
  return {
    activities: new SessionActivityRegistry(),
    beginObservedTurn: () => ({ kind: 'registered', settle: async () => {} }),
    bindHost: () => () => {},
  };
}

function parseHarnessOptions(argv: readonly string[]): HarnessOptions {
  let rootPath: string | undefined;
  let cwd = process.cwd();
  let connectionSlug: string | undefined;
  let model: string | undefined;
  let resumeSessionId: string | undefined;
  let permissionMode: PermissionMode = 'ask';
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key !== '--root' &&
      key !== '--cwd' &&
      key !== '--connection' &&
      key !== '--model' &&
      key !== '--resume' &&
      key !== '--permission'
    ) {
      throw new Error(`Unknown Runtime Host TUI harness option: ${key ?? ''}`);
    }
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    index += 1;
    if (key === '--root') rootPath = value;
    else if (key === '--cwd') cwd = value;
    else if (key === '--connection') connectionSlug = value;
    else if (key === '--model') model = value;
    else if (key === '--resume') resumeSessionId = value;
    else permissionMode = requirePermissionMode(value);
  }
  if (!rootPath) {
    throw new Error(
      'Runtime Host TUI harness requires --root <isolated-root>; it never targets the production CLI root implicitly',
    );
  }
  return {
    rootPath,
    cwd,
    ...(connectionSlug === undefined ? {} : { connectionSlug }),
    ...(model === undefined ? {} : { model }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    permissionMode,
  };
}

function requirePermissionMode(value: string): PermissionMode {
  if (value === 'ask' || value === 'execute' || value === 'explore' || value === 'bypass') {
    return value;
  }
  throw new Error(`Invalid --permission mode: ${value}`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runRuntimeHostTuiHarness().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
