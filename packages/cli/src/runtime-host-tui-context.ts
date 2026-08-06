import { randomUUID } from 'node:crypto';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { SessionActivityRegistry, type InvocableSkillEntry } from '@maka/runtime';
import {
  connectOrSpawnRuntimeHost,
  readRuntimeHostConnectionCatalog,
  readRuntimeHostSkillCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import type { ModelChoice } from './connection-target.js';
import type { MakaPiTuiGoalLifecycle } from './pi-tui-runner.js';
import type { SessionRecapGenerator } from './runtime-bootstrap.js';
import {
  createRuntimeHostMakaSessionDriver,
  type RuntimeHostMakaSessionDriverInput,
} from './runtime-host-session-driver.js';

export interface RuntimeHostTuiContext {
  readonly connection: RuntimeHostConnection;
  readonly driver: ReturnType<typeof createRuntimeHostMakaSessionDriver>;
  readonly cwd: string;
  readonly connectionSlug: string;
  readonly connectionName: string;
  readonly providerType: ConnectionCatalogEntry['providerType'];
  readonly model: string;
  readonly modelContextWindow?: number;
  readonly modelChoices: readonly ModelChoice[];
  readonly goalLifecycle: MakaPiTuiGoalLifecycle;
  readonly listSkills: (cwd: string) => Promise<readonly InvocableSkillEntry[]>;
  readonly recap: SessionRecapGenerator;
  close(): Promise<void>;
}

export interface CreateRuntimeHostTuiContextInput {
  readonly rootPath: string;
  readonly cwd: string;
  readonly resumeSessionId?: string;
}

export async function createRuntimeHostTuiContext(
  input: CreateRuntimeHostTuiContextInput,
): Promise<RuntimeHostTuiContext> {
  const connected = await connectOrSpawnRuntimeHost({
    rootPath: input.rootPath,
    surface: 'tui',
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  if (connected.kind === 'incompatible') {
    throw new Error(
      `Runtime Host protocol is incompatible (Host ${connected.handshake.protocolMin}-${connected.handshake.protocolMax}, CLI ${RUNTIME_HOST_PROTOCOL_VERSION})`,
    );
  }
  if (connected.kind === 'failed') {
    throw new Error(`Runtime Host startup failed: ${connected.reason}`);
  }
  const connection = connected.connection;
  try {
    await waitForReady(connection);
    const catalog = await loadConnectionCatalog(connection);
    const target = input.resumeSessionId
      ? await resolveResumeTarget(connection, catalog, input.resumeSessionId)
      : resolveTarget(catalog);
    const modelChoices = projectModelChoices(catalog);
    const driverInput: RuntimeHostMakaSessionDriverInput = {
      connection,
      cwd: input.cwd,
      llmConnectionSlug: target.connection.slug,
      model: target.model,
      permissionMode: 'ask',
    };
    const driver = createRuntimeHostMakaSessionDriver(driverInput);
    return {
      connection,
      driver,
      cwd: input.cwd,
      connectionSlug: target.connection.slug,
      connectionName: target.connection.name,
      providerType: target.connection.providerType,
      model: target.model,
      modelContextWindow: target.connection.models.find((model) => model.id === target.model)
        ?.contextWindow,
      modelChoices,
      goalLifecycle: createHostOwnedGoalLifecycle(),
      listSkills: (cwd) => listStablePresentedSkills(connection, cwd),
      recap: createRuntimeHostRecapGenerator(connection),
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

function createRuntimeHostRecapGenerator(connection: RuntimeHostConnection): SessionRecapGenerator {
  return {
    generate: async (sessionId, reason) => {
      try {
        const result = await connection.request('session.recap.generate', {
          sessionId,
          effectId: randomUUID(),
          reason,
        });
        return result.kind === 'generated'
          ? { ok: true, text: result.text, raw: result.raw }
          : { ok: false, error: result.errorClass };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

async function listStablePresentedSkills(
  connection: RuntimeHostConnection,
  projectRoot: string,
): Promise<InvocableSkillEntry[]> {
  const catalog = await readRuntimeHostSkillCatalog(connection, { projectRoot }, 'governance');
  return catalog.items.flatMap((item) =>
    item.kind === 'skill' &&
    item.enabled &&
    item.runtimeStatus === 'enabled' &&
    (item.contextStatus === 'advertised' || item.contextStatus === 'unknown')
      ? [{ ref: item.ref, id: item.id, name: item.name, description: item.description }]
      : [],
  );
}

async function waitForReady(connection: RuntimeHostConnection): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (true) {
    const status = await connection.status(Math.max(1, deadline - Date.now()));
    if (status.state === 'ready') return;
    if (status.state === 'draining') throw new Error('Runtime Host drained before becoming ready');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Runtime Host did not become ready before the deadline');
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
}

async function loadConnectionCatalog(
  connection: RuntimeHostConnection,
): Promise<ConnectionCatalogSnapshot> {
  return readRuntimeHostConnectionCatalog(connection);
}

function resolveTarget(catalog: ConnectionCatalogSnapshot): {
  connection: ConnectionCatalogEntry;
  model: string;
} {
  const target = catalog.defaultTarget;
  if (!target) throw new Error('Runtime Host has no default model connection');
  const connection = catalog.connections.find(
    (candidate) => candidate.connectionId === target.connectionId,
  );
  if (!connection || !connection.enabled) {
    throw new Error('Runtime Host default model connection is unavailable');
  }
  return { connection, model: target.modelId };
}

async function resolveResumeTarget(
  connection: RuntimeHostConnection,
  catalog: ConnectionCatalogSnapshot,
  sessionId: string,
): Promise<{ connection: ConnectionCatalogEntry; model: string }> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  const session = result.kind === 'session' ? result.session : null;
  if (session && !('kind' in session)) {
    const sessionConnection = catalog.connections.find(
      (candidate) => candidate.slug === session.llmConnectionSlug && candidate.enabled,
    );
    if (sessionConnection) return { connection: sessionConnection, model: session.model };
  }
  return resolveTarget(catalog);
}

function projectModelChoices(catalog: ConnectionCatalogSnapshot): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const connection of catalog.connections) {
    if (!connection.enabled) continue;
    const modelsById = new Map(connection.models.map((model) => [model.id, model]));
    const ids = new Set(connection.enabledModelIds);
    if (catalog.defaultTarget?.connectionId === connection.connectionId) {
      ids.add(catalog.defaultTarget.modelId);
    }
    for (const model of ids) {
      choices.push({
        connectionSlug: connection.slug,
        connectionName: connection.name,
        providerType: connection.providerType,
        model,
        isDefaultConnection: catalog.defaultTarget?.connectionId === connection.connectionId,
        contextWindow: modelsById.get(model)?.contextWindow,
      });
    }
  }
  return choices;
}

function createHostOwnedGoalLifecycle(): MakaPiTuiGoalLifecycle {
  return {
    activities: new SessionActivityRegistry(),
    beginObservedTurn: () => ({ kind: 'registered', settle: async () => {} }),
    // Goal continuation is a Runtime Host responsibility. Binding a local
    // admission callback would create a second scheduler authority.
    bindHost: () => () => {},
  };
}
