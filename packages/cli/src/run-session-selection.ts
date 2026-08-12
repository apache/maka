import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary } from '@maka/core/session';

export interface MakaRunSessionSelectionInput {
  sessions: readonly SessionSummary[];
  resumeId?: string;
  continueLatest: boolean;
  explicitCwd?: string;
  processCwd: string;
  explicitConnection?: string;
  explicitModel?: string;
  thinkingSpecified: boolean;
  explicitThinking?: ThinkingLevel;
  explicitPermissionMode?: Exclude<PermissionMode, 'ask'>;
}

export type MakaRunSessionSelection =
  | { kind: 'new'; cwd: string }
  | { kind: 'existing'; cwd: string; session: SessionSummary };

export interface MakaRunSessionSelectionDeps {
  canonicalizeDirectory(path: string): Promise<string>;
  canonicalizeStoredDirectory?(path: string): Promise<string>;
}

export async function selectMakaRunSession(
  input: MakaRunSessionSelectionInput,
  deps: MakaRunSessionSelectionDeps,
): Promise<MakaRunSessionSelection> {
  if (input.resumeId !== undefined && input.continueLatest) {
    throw new Error('--resume and --continue cannot be used together');
  }
  if (input.resumeId !== undefined) return selectExplicitSession(input, deps);
  if (input.continueLatest) return selectLatestSession(input, deps);
  return {
    kind: 'new',
    cwd: await deps.canonicalizeDirectory(input.explicitCwd ?? input.processCwd),
  };
}

async function selectExplicitSession(
  input: MakaRunSessionSelectionInput & { resumeId?: string },
  deps: MakaRunSessionSelectionDeps,
): Promise<Extract<MakaRunSessionSelection, { kind: 'existing' }>> {
  const session = input.sessions.find((candidate) => candidate.id === input.resumeId);
  if (!session) throw new Error(`session not found: ${input.resumeId}`);
  assertSupportedSession(session);
  const cwd = await canonicalSessionCwd(session, deps);
  if (input.explicitCwd !== undefined) {
    const explicitCwd = await deps.canonicalizeDirectory(input.explicitCwd);
    if (explicitCwd !== cwd) {
      throw new Error(`--cwd conflicts with resumed session ${session.id}`);
    }
  }
  assertExplicitConfigurationCompatible(session, input);
  return { kind: 'existing', cwd, session };
}

async function selectLatestSession(
  input: MakaRunSessionSelectionInput,
  deps: MakaRunSessionSelectionDeps,
): Promise<Extract<MakaRunSessionSelection, { kind: 'existing' }>> {
  const cwd = await deps.canonicalizeDirectory(input.explicitCwd ?? input.processCwd);
  const candidates = input.sessions.filter(isContinueCandidate).sort((left, right) => {
    const timeDelta = right.lastMessageAt! - left.lastMessageAt!;
    return timeDelta !== 0 ? timeDelta : left.id.localeCompare(right.id);
  });
  for (const session of candidates) {
    const sessionCwd = await tryCanonicalSessionCwd(session, deps);
    if (sessionCwd !== cwd) continue;
    assertExplicitConfigurationCompatible(session, input);
    return { kind: 'existing', cwd: sessionCwd, session };
  }
  throw new Error(`no compatible session found for cwd: ${cwd}`);
}

function isContinueCandidate(session: SessionSummary): boolean {
  return (
    session.subagentParent === undefined &&
    !session.isArchived &&
    (session.status === 'active' || session.status === 'aborted') &&
    typeof session.lastMessageAt === 'number' &&
    Number.isFinite(session.lastMessageAt) &&
    session.backend === 'ai-sdk'
  );
}

function assertSupportedSession(session: SessionSummary): void {
  if (session.backend !== 'ai-sdk') {
    throw new Error(`session ${session.id} uses unsupported backend: ${session.backend}`);
  }
}

function assertExplicitConfigurationCompatible(
  session: SessionSummary,
  input: Pick<
    MakaRunSessionSelectionInput,
    | 'explicitConnection'
    | 'explicitModel'
    | 'thinkingSpecified'
    | 'explicitThinking'
    | 'explicitPermissionMode'
  >,
): void {
  if (
    input.explicitConnection !== undefined &&
    input.explicitConnection !== session.llmConnectionSlug
  ) {
    throw new Error(`--connection conflicts with resumed session ${session.id}`);
  }
  if (input.explicitModel !== undefined && input.explicitModel !== session.model) {
    throw new Error(`--model conflicts with resumed session ${session.id}`);
  }
  if (input.thinkingSpecified && input.explicitThinking !== session.thinkingLevel) {
    throw new Error(`--thinking conflicts with resumed session ${session.id}`);
  }
  if (
    input.explicitPermissionMode !== undefined &&
    input.explicitPermissionMode !== session.permissionMode
  ) {
    throw new Error(`--permission-mode conflicts with resumed session ${session.id}`);
  }
}

async function canonicalSessionCwd(
  session: SessionSummary,
  deps: MakaRunSessionSelectionDeps,
): Promise<string> {
  if (!session.cwd) throw new Error(`session ${session.id} has no stored cwd`);
  try {
    return await (deps.canonicalizeStoredDirectory ?? deps.canonicalizeDirectory)(session.cwd);
  } catch {
    throw new Error(`session ${session.id} cwd is missing or inaccessible: ${session.cwd}`);
  }
}

async function tryCanonicalSessionCwd(
  session: SessionSummary,
  deps: MakaRunSessionSelectionDeps,
): Promise<string | undefined> {
  try {
    return await canonicalSessionCwd(session, deps);
  } catch {
    return undefined;
  }
}
