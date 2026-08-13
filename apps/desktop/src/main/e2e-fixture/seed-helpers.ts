import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  acquireOperationalStateDatabase,
  createSqliteSessionMetadataStore,
  OPERATIONAL_STATE_DATABASE_NAME,
  projectSessionCatalogMessages,
} from '@maka/storage';

// Fixed clock for the e2e-fixture. All seeded timestamps and
// transient fixture state derive from this value unless tests explicitly
// pass `now`, so two runs produce identical visible time copy.
export const E2E_FIXTURE_NOW = Date.UTC(2026, 4, 22, 3, 0, 0);

export const TURN_SESSION_ID = 'e2e-fixture-turn';
export const PROMPT_RAIL_SESSION_ID = 'e2e-fixture-prompt-rail';
/**
 * Prompts seeded for the prompt-rail fixture. Three constraints set the
 * number: the rail renders nothing below three prompts, the transcript has to
 * overflow the scrollport or its pinning has nothing to be pinned against,
 * and — the binding one — it must exceed the progressive mount's initial
 * window of ten, or the head of the transcript is already mounted when the
 * fixture opens and the jump-into-unmounted-turns path never runs. At eight
 * prompts the spec could not see that bug at all.
 */
export const PROMPT_RAIL_PROMPT_COUNT = 30;
export const LONG_SIDEBAR_SESSION_PREFIX = 'e2e-fixture-sidebar-long-';
export const LONG_SIDEBAR_SESSION_COUNT = 60;
export const LONG_SIDEBAR_PROJECT_ID = 'e2e-fixture-project';
export const LONG_SIDEBAR_PROJECT_NAME = '示例项目';
export const LONG_SIDEBAR_PROJECT_SESSION_COUNT = 3;

export function header(input: {
  id: string;
  name: string;
  connection: string;
  model: string;
  now: number;
  lastMessageAt: number;
  projectId?: string;
}): SessionHeader {
  return {
    id: input.id,
    workspaceRoot: 'e2e-fixture',
    cwd: '/workspace/maka',
    createdAt: input.now - 3_600_000,
    lastUsedAt: input.lastMessageAt,
    lastMessageAt: input.lastMessageAt,
    name: input.name,
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: input.lastMessageAt,
    hasUnread: false,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    backend: 'ai-sdk',
    llmConnectionSlug: input.connection,
    connectionLocked: true,
    model: input.model,
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}

export async function writeSession(
  workspaceRoot: string,
  session: SessionHeader,
  messages: StoredMessage[],
): Promise<void> {
  const rootedSession: SessionHeader = {
    ...session,
    workspaceRoot,
    cwd: workspaceRoot,
  };
  const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
  const sessions = createSqliteSessionMetadataStore(
    join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME),
    { databaseLease },
  );
  try {
    await sessions.create(rootedSession);
    await sessions.appendMessages(
      rootedSession.id,
      messages,
      projectSessionCatalogMessages(messages),
    );
  } finally {
    sessions.close();
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
