import { randomUUID } from 'node:crypto';
import type { PermissionMode } from '@maka/core/permission';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { SessionActivityRegistry, type InvocableSkillEntry } from '@maka/runtime';
import {
  readRuntimeHostInvocableSkills,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { connectRuntimeHostCli, resolveRuntimeHostCliTarget } from './runtime-host-cli-context.js';
import type {
  MakaPiTuiTurnActivitySurface,
  ModelChoice,
  SessionRecapGenerator,
} from './pi-tui-contracts.js';
import {
  createRuntimeHostMakaSessionDriver,
  type RuntimeHostMakaSessionDriverInput,
} from './runtime-host-session-driver.js';
import {
  createRuntimeHostOnboardingSurface,
  projectRuntimeHostModelChoices,
} from './runtime-host-onboarding.js';

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
  readonly turnActivity: MakaPiTuiTurnActivitySurface;
  readonly listSkills: (cwd: string) => Promise<readonly InvocableSkillEntry[]>;
  readonly recap: SessionRecapGenerator;
  readonly onboarding: ReturnType<typeof createRuntimeHostOnboardingSurface>;
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
  const connected = await connectRuntimeHostCli({
    rootPath: input.rootPath,
    surface: 'tui',
  });
  const connection = connected.connection;
  try {
    const catalog = connected.catalog;
    const target = input.resumeSessionId
      ? await resolveResumeTarget(connection, catalog, input.resumeSessionId)
      : resolveTarget(catalog);
    const modelChoices = projectRuntimeHostModelChoices(catalog);
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
      turnActivity: createHostOwnedTurnActivity(),
      listSkills: (cwd) =>
        listStablePresentedSkills(connection, cwd, driver.getPermissionMode?.() ?? 'ask'),
      recap: createRuntimeHostRecapGenerator(connection),
      onboarding: createRuntimeHostOnboardingSurface(connection),
      close: () => connected.close(),
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
  permissionMode: PermissionMode,
): Promise<InvocableSkillEntry[]> {
  return [
    ...(await readRuntimeHostInvocableSkills(connection, {
      kind: 'new_session',
      context: { projectRoot },
      collaborationMode: 'agent',
      permissionMode,
    })),
  ];
}

function resolveTarget(catalog: ConnectionCatalogSnapshot): {
  connection: ConnectionCatalogEntry;
  model: string;
} {
  return resolveRuntimeHostCliTarget(catalog);
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

function createHostOwnedTurnActivity(): MakaPiTuiTurnActivitySurface {
  return { activities: new SessionActivityRegistry() };
}
