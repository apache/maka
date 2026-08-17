import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { createGenesisExecutionBoundary } from '@maka/core/sandbox-boundary';
import { DEEP_RESEARCH_SESSION_LABEL, DEEP_RESEARCH_SESSION_NAME } from '@maka/core/explore-agent';
import { type RelayModelProfile } from '@maka/core/model-thinking';
import { type SessionHeader } from '@maka/core/session';
import {
  SessionConfigurationTransitionError,
  headerToSummary,
} from '@maka/runtime/session-manager';
import { type ProjectCatalog, ProjectUnavailableError } from '@maka/storage';
import {
  SessionMetadataVersionConflictError,
  type SessionCatalogRecord,
} from '@maka/storage/execution-stores';
import {
  SESSION_CATALOG_RESULT_MAX_BYTES,
  SESSION_TURN_QUERY_RESULT_MAX_BYTES,
  type SessionConfigurationUpdateInput,
  type SessionTurnContribution,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostProjectMembershipGate } from '../server/project-membership-gate.js';
import { HostWorkspaceResolver } from '../server/workspace-resolver.js';
import {
  HostSessionCatalogCoordinator,
  type HostSessionCatalogCoordinatorOptions,
} from '../server/session-catalog-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

type CatalogStores = HostSessionCatalogCoordinatorOptions['stores'];
type RuntimePolicy = HostSessionCatalogCoordinatorOptions['runtimePolicy'];
type ConfigurationAuthority = HostSessionCatalogCoordinatorOptions['manager'];
type SessionContinuity = HostSessionCatalogCoordinatorOptions['continuity'];

const context: ConnectionContext = {
  hostEpoch: 'session-catalog-test-epoch',
  connectionId: 'session-catalog-test-client',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('projects only bounded execution boundary presentation facts', async () => {
  const fixture = createFixture({
    stores: {
      readExecutionBoundary: async () => createGenesisExecutionBoundary('explore'),
    },
  });

  const outcome = await fixture.coordinator.handlers['session.execution_boundary.query'](
    { sessionId: fixture.sessionId },
    context,
  );

  assert.deepEqual(outcome, {
    ok: true,
    result: { kind: 'managed', access: 'read_only', revision: 0 },
  });
});

test('reduces turn pages to their encoded wire budget without skipping contributions', async () => {
  const contributions: SessionTurnContribution[] = Array.from({ length: 128 }, (_, index) => ({
    turnId: `turn-${index}`,
    firstSequence: index,
    latestState: null,
    userPromptPreview: '\0'.repeat(256),
    hasAssistantMessage: false,
    hasAssistantOutput: false,
    hasToolResult: false,
    hasFailedToolResult: false,
    hasAbortNote: false,
  }));
  const requestedLimits: number[] = [];
  const fixture = createFixture({
    stores: {
      readTurnContributionsSnapshot: async (_sessionId, _watermark, position, limit) => {
        requestedLimits.push(limit);
        const end = Math.min(position + limit, contributions.length);
        return {
          throughSequence: contributions.length - 1,
          contributions: contributions.slice(position, end),
          nextPosition: end < contributions.length ? end : null,
        };
      },
    },
  });

  const seen: string[] = [];
  let position = 0;
  do {
    const outcome = await fixture.coordinator.handlers['session.turns.query'](
      {
        sessionId: fixture.sessionId,
        throughSequence: null,
        position,
        maxContributions: 128,
      },
      context,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) assert.fail('Turn query failed');
    assert.ok(
      Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <=
        SESSION_TURN_QUERY_RESULT_MAX_BYTES,
    );
    seen.push(...outcome.result.contributions.map((contribution) => contribution.turnId));
    if (outcome.result.nextPosition === null) break;
    assert.ok(outcome.result.nextPosition > position);
    position = outcome.result.nextPosition;
  } while (true);

  assert.deepEqual(
    seen,
    contributions.map((contribution) => contribution.turnId),
  );
  assert.ok(requestedLimits.some((limit) => limit < 128));
});

test('metadata replacement preserves execution-semantic labels and ignores injected ones', async () => {
  const fixture = createFixture({
    labels: ['old-user-label', DEEP_RESEARCH_SESSION_LABEL],
  });

  const outcome = await fixture.coordinator.handlers['session.metadata.update'](
    {
      sessionId: fixture.sessionId,
      expectedRevision: fixture.revision(),
      patch: {
        labels: ['new-user-label', DEEP_RESEARCH_SESSION_LABEL],
      },
    },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.result.kind !== 'committed') {
    assert.fail('Metadata replacement did not commit');
  }
  if ('kind' in outcome.result.session) {
    assert.fail('Metadata replacement returned an unsupported Session projection');
  }
  assert.deepEqual(outcome.result.session.labels, ['new-user-label', DEEP_RESEARCH_SESSION_LABEL]);
  assert.equal(fixture.drainRequests(), 0);
});

test('metadata commit uncertainty requests Host drain, while a typed conflict does not', async () => {
  const uncertain = createFixture({
    continuity: {
      refreshCanonical: async () => {
        throw new Error('injected publication failure');
      },
    },
  });
  const uncertainOutcome = await uncertain.coordinator.handlers['session.metadata.update'](
    {
      sessionId: uncertain.sessionId,
      expectedRevision: uncertain.revision(),
      patch: { isFlagged: true },
    },
    context,
  );
  assert.deepEqual(uncertainOutcome, {
    ok: false,
    error: {
      code: 'commit_outcome_unknown',
      message: 'Session metadata update outcome is unknown',
    },
  });
  assert.equal(uncertain.drainRequests(), 1);

  const conflict = createFixture({
    stores: {
      updateHeaderVersioned: async (sessionId, _patch, expectedRevision) => {
        throw new SessionMetadataVersionConflictError(
          sessionId,
          expectedRevision,
          expectedRevision + 1,
        );
      },
    },
  });
  const conflictOutcome = await conflict.coordinator.handlers['session.metadata.update'](
    {
      sessionId: conflict.sessionId,
      expectedRevision: conflict.revision(),
      patch: { isFlagged: true },
    },
    context,
  );
  assert.deepEqual(conflictOutcome, {
    ok: true,
    result: {
      kind: 'revision_conflict',
      expectedRevision: conflict.revision(),
      actualRevision: conflict.revision() + 1,
    },
  });
  assert.equal(conflict.drainRequests(), 0);
});

test('configuration failures distinguish pre-commit loss from post-commit uncertainty', async () => {
  const preCommit = createFixture({
    stores: {
      readHeaderRecordSnapshot: async () => {
        throw new Error('injected pre-commit read failure');
      },
    },
  });
  const preCommitOutcome = await preCommit.coordinator.handlers['session.configuration.update'](
    configurationInput(preCommit.sessionId, preCommit.revision()),
    context,
  );
  assert.deepEqual(preCommitOutcome, {
    ok: false,
    error: {
      code: 'persistence_failed',
      message: 'Session configuration authority is unavailable',
    },
  });
  assert.equal(preCommit.drainRequests(), 1);

  const postCommit = createFixture({
    manager: {
      transitionSessionConfiguration: async () => {
        throw new Error('injected commit-unknown failure');
      },
    },
  });
  const postCommitOutcome = await postCommit.coordinator.handlers['session.configuration.update'](
    configurationInput(postCommit.sessionId, postCommit.revision()),
    context,
  );
  assert.deepEqual(postCommitOutcome, {
    ok: false,
    error: {
      code: 'commit_outcome_unknown',
      message: 'Session configuration update outcome is unknown',
    },
  });
  assert.equal(postCommit.drainRequests(), 1);
});

test('typed configuration rejection does not request Host drain', async () => {
  const fixture = createFixture({
    manager: {
      transitionSessionConfiguration: async () => {
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session configuration cannot change while a linked Turn is active',
        );
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.configuration.update'](
    configurationInput(fixture.sessionId, fixture.revision()),
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'session_busy',
      message: 'Session configuration cannot change while a linked Turn is active',
    },
  });
  assert.equal(fixture.drainRequests(), 0);
});

test('creation rejects reserved execution labels before claiming a Session identity', async () => {
  let createAttempts = 0;
  const fixture = createFixture({
    stores: {
      createStableSession: async () => {
        createAttempts += 1;
        assert.fail('Reserved labels must be rejected before persistence');
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      labels: [DEEP_RESEARCH_SESSION_LABEL],
      modelTarget: { kind: 'default' },
    },
    context,
  );
  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Session creation cannot set reserved execution labels',
    },
  });
  assert.equal(createAttempts, 0);
  assert.equal(fixture.drainRequests(), 0);
});

test('creation on a relay connection honours declared levels via the catalog projection', async () => {
  // The catalog entry carries the typed relayModelProfiles projection (never
  // the extras bag), so a declared relay level passes the gate — and what
  // passes is exactly what execution rebuilds the runtime connection from.
  let createAttempts = 0;
  let persistedThinkingLevel: unknown;
  const fixture = createFixture({
    connection: {
      providerType: 'openai-compatible',
      enabledModelIds: ['relay-model'],
      models: [{ id: 'relay-model' }],
      relayModelProfiles: { 'relay-model': { thinkingLevels: ['minimal', 'low'] } },
    },
    stores: {
      createStableSession: async (args) => {
        createAttempts += 1;
        persistedThinkingLevel = args.input.thinkingLevel;
        return {
          kind: 'existing' as const,
          record: headerSnapshot(sessionHeader(args.sessionId, ['user-label']), 1),
        };
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      modelTarget: { kind: 'explicit', connectionSlug: 'test', model: 'relay-model' },
      thinkingLevel: 'low',
    },
    context,
  );

  assert.equal(outcome.ok, true);
  assert.equal(createAttempts, 1);
  assert.equal(persistedThinkingLevel, 'low');
});

test('creation admits the enabled bootstrap DeepSeek model before discovery', async () => {
  const modelId = 'deepseek-v4-flash';
  let createAttempts = 0;
  const fixture = createFixture({
    connection: {
      providerType: 'deepseek',
      enabledModelIds: [modelId],
      models: [],
    },
    stores: {
      createStableSession: async (args) => {
        createAttempts += 1;
        return {
          kind: 'existing' as const,
          record: headerSnapshot(
            { ...sessionHeader(args.sessionId, ['user-label']), model: modelId },
            1,
          ),
        };
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      modelTarget: { kind: 'explicit', connectionSlug: 'test', model: modelId },
    },
    context,
  );

  assert.equal(outcome.ok, true);
  assert.equal(createAttempts, 1);
});

test('creation does not bypass a non-empty DeepSeek inventory', async () => {
  const modelId = 'deepseek-v4-flash';
  let createAttempts = 0;
  const fixture = createFixture({
    connection: {
      providerType: 'deepseek',
      enabledModelIds: [modelId],
      models: [{ id: 'deepseek-chat' }],
    },
    stores: {
      createStableSession: async () => {
        createAttempts += 1;
        assert.fail('A model missing from a non-empty inventory must not be persisted');
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      modelTarget: { kind: 'explicit', connectionSlug: 'test', model: modelId },
    },
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: { code: 'invalid_request', message: 'Session model is not enabled' },
  });
  assert.equal(createAttempts, 0);
});

test('creation on a relay connection without declarations still fails closed on any thinkingLevel', async () => {
  // Undeclared relay models resolve no variants — accepting an unverifiable
  // level would be worse than rejecting it, because the wire could never
  // honour what the catalog cannot see.
  let createAttempts = 0;
  const fixture = createFixture({
    connection: {
      providerType: 'openai-compatible',
      enabledModelIds: ['relay-model'],
      models: [{ id: 'relay-model' }],
    },
    stores: {
      createStableSession: async () => {
        createAttempts += 1;
        assert.fail('Unverifiable thinking levels must be rejected before persistence');
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      modelTarget: { kind: 'explicit', connectionSlug: 'test', model: 'relay-model' },
      thinkingLevel: 'low',
    },
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Session model does not support thinking level low',
    },
  });
  assert.equal(createAttempts, 0);
});

test('creation rejects explore permission without a declared mode', async () => {
  let createAttempts = 0;
  const fixture = createFixture({
    stores: {
      createStableSession: async () => {
        createAttempts += 1;
        assert.fail('Unscoped explore permission must be rejected before persistence');
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      modelTarget: { kind: 'default' },
      permissionMode: 'explore',
    },
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Session creation requires a declared mode for explore permission',
    },
  });
  assert.equal(createAttempts, 0);
  assert.equal(fixture.drainRequests(), 0);
});

test('creation materializes Deep Research semantics inside the Host transaction', async () => {
  let created: Parameters<CatalogStores['createStableSession']>[0] | undefined;
  const fixture = createFixture({
    stores: {
      createStableSession: async (request) => {
        created = request;
        return {
          kind: 'existing',
          record: headerSnapshot(sessionHeader(request.sessionId, request.input.labels ?? []), 3),
        };
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'host_path', path: process.cwd() },
      mode: 'deep_research',
      name: 'Caller override',
      labels: ['customer-label'],
      modelTarget: { kind: 'default' },
      permissionMode: 'execute',
    },
    context,
  );

  assert.equal(outcome.ok, true);
  assert.ok(created);
  assert.equal(created.input.name, DEEP_RESEARCH_SESSION_NAME);
  assert.deepEqual(created.input.labels, ['customer-label', DEEP_RESEARCH_SESSION_LABEL]);
  assert.equal(created.input.permissionMode, 'explore');
  assert.equal(fixture.drainRequests(), 0);
});

test('configuration update admits Plan mode through Runtime authority', async () => {
  const fixture = createFixture();
  const input = configurationInput(fixture.sessionId, fixture.revision());

  const outcome = await fixture.coordinator.handlers['session.configuration.update'](
    {
      ...input,
      configuration: {
        ...input.configuration,
        collaborationMode: 'plan',
      },
    },
    context,
  );

  if (!outcome.ok || outcome.result.kind !== 'committed') {
    assert.fail('Plan mode configuration did not commit');
  }
  if ('kind' in outcome.result.session) {
    assert.fail('Plan mode configuration returned an unsupported Session projection');
  }
  assert.equal(outcome.result.session.collaborationMode, 'plan');
  assert.equal(fixture.header().collaborationMode, 'plan');
  assert.equal(fixture.drainRequests(), 0);
});

test('creation persists a canonical cwd while fingerprints retain exact target intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-create-cwd-'));
  const target = join(root, 'target');
  const link = join(root, 'link');
  await mkdir(target);
  await symlink(target, link, 'dir');
  try {
    const requests: Parameters<CatalogStores['createStableSession']>[0][] = [];
    const fixture = createFixture({
      stores: {
        createStableSession: async (request) => {
          requests.push(request);
          return {
            kind: 'existing',
            record: headerSnapshot(
              {
                ...sessionHeader(request.sessionId, request.input.labels ?? []),
                cwd: request.input.cwd,
              },
              3,
            ),
          };
        },
      },
    });
    for (const cwd of [link, target]) {
      const outcome = await fixture.coordinator.handlers['session.create'](
        {
          sessionId: fixture.sessionId,
          workspace: { kind: 'host_path', path: cwd },
          modelTarget: { kind: 'default' },
        },
        context,
      );
      assert.equal(outcome.ok, true);
    }

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.input.cwd, await realpath(target));
    assert.equal(requests[1]?.input.cwd, await realpath(target));
    assert.notEqual(requests[0]?.requestFingerprint, requests[1]?.requestFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact Project creation retry succeeds after the Project becomes archived', async () => {
  const fixture = createFixture({
    projectCatalog: {
      list: async () => [
        {
          id: 'project-1',
          name: 'Project',
          locations: [{ path: '/archived', isWorktree: false }],
          archivedAt: 1,
          available: true,
          preferredPath: '/archived',
        },
      ],
    } as never,
    stores: {
      probeStableSessionCreate: async () => ({
        kind: 'existing',
        record: headerSnapshot(sessionHeader('session-1', ['user-label']), 3),
      }),
    },
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'project', projectId: 'project-1' },
      modelTarget: { kind: 'default' },
    },
    context,
  );

  assert.equal(outcome.ok, true);
  assert.equal(fixture.drainRequests(), 0);
});

test('creation resolves a Project alias and records Host-owned usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-create-project-'));
  const currentPath = join(root, 'current');
  await mkdir(currentPath);
  try {
    let created: Parameters<CatalogStores['createStableSession']>[0] | undefined;
    const touches: Array<{ projectId: string; path?: string }> = [];
    let projectChanges = 0;
    const fixture = createFixture({
      onProjectChanged: () => {
        projectChanges += 1;
      },
      projectCatalog: {
        list: async () => [
          {
            id: 'project-current',
            aliases: ['project-stale'],
            name: 'Project',
            locations: [{ path: currentPath, isWorktree: false }],
            available: true,
            preferredPath: currentPath,
          },
        ],
        touch: async (projectId: string, path?: string) => {
          touches.push({ projectId, path });
          return {} as never;
        },
      } as never,
      stores: {
        createStableSession: async (request) => {
          created = request;
          return {
            kind: 'existing',
            record: headerSnapshot(
              {
                ...sessionHeader(request.sessionId, []),
                cwd: request.input.cwd,
                projectId: request.input.projectId,
              },
              1,
            ),
          };
        },
      },
    });

    const outcome = await fixture.coordinator.handlers['session.create'](
      {
        sessionId: fixture.sessionId,
        workspace: { kind: 'project', projectId: 'project-stale' },
        modelTarget: { kind: 'default' },
      },
      context,
    );

    assert.equal(outcome.ok, true);
    assert.equal(created?.input.cwd, currentPath);
    assert.equal(created?.input.projectId, 'project-current');
    assert.deepEqual(touches, [{ projectId: 'project-current', path: currentPath }]);
    assert.equal(projectChanges, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creation reports a Project path lost before usage recording without draining', async () => {
  const fixture = createFixture({
    projectCatalog: {
      list: async () => [
        {
          id: 'project-1',
          name: 'Project',
          locations: [{ path: '/missing', isWorktree: false }],
          available: true,
          preferredPath: '/missing',
        },
      ],
      touch: async () => {
        throw new ProjectUnavailableError('project-1');
      },
    } as never,
  });

  const outcome = await fixture.coordinator.handlers['session.create'](
    {
      sessionId: fixture.sessionId,
      workspace: { kind: 'project', projectId: 'project-1' },
      modelTarget: { kind: 'default' },
    },
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: { code: 'operation_conflict', message: 'Project is unavailable: project-1' },
  });
  assert.equal(fixture.drainRequests(), 0);
});

test('Host-path relocation canonicalizes once and commits through Runtime authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-relocate-cwd-'));
  const target = join(root, 'target');
  const link = join(root, 'link');
  await mkdir(target);
  await symlink(target, link, 'dir');
  try {
    const fixture = createFixture();
    const expectedRevision = fixture.revision();
    const outcome = await fixture.coordinator.handlers['session.workspace.relocate'](
      {
        sessionId: fixture.sessionId,
        expectedRevision,
        workspace: { kind: 'host_path', path: link },
      },
      context,
    );

    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'committed') return;
    if ('kind' in outcome.result.session) {
      assert.fail('Relocated Session must remain wire-representable');
    }
    assert.equal(outcome.result.session.workspace.hostCwd, await realpath(target));
    assert.equal(fixture.header().cwd, await realpath(target));
    assert.equal(fixture.header().projectId, null);
    assert.equal(fixture.revision(), expectedRevision + 1);
    assert.equal(fixture.drainRequests(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace relocation reports a stale Session revision without mutating Runtime state', async () => {
  let relocationAttempts = 0;
  const fixture = createFixture({
    manager: {
      relocateSessionWorkspace: async () => {
        relocationAttempts += 1;
        assert.fail('Stale relocation must not enter Runtime authority');
      },
    },
  });
  const outcome = await fixture.coordinator.handlers['session.workspace.relocate'](
    {
      sessionId: fixture.sessionId,
      expectedRevision: fixture.revision() - 1,
      workspace: { kind: 'host_path', path: process.cwd() },
    },
    context,
  );

  assert.deepEqual(outcome, {
    ok: true,
    result: {
      kind: 'revision_conflict',
      expectedRevision: fixture.revision() - 1,
      actualRevision: fixture.revision(),
    },
  });
  assert.equal(relocationAttempts, 0);
  assert.equal(fixture.drainRequests(), 0);
});

test('same-workspace relocation still enters Runtime eligibility authority', async () => {
  let relocationAttempts = 0;
  const cwd = await realpath(process.cwd());
  const fixture = createFixture({
    cwd,
    manager: {
      relocateSessionWorkspace: async () => {
        relocationAttempts += 1;
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session workspace cannot change while a Turn is active',
        );
      },
    },
  });

  const outcome = await fixture.coordinator.handlers['session.workspace.relocate'](
    {
      sessionId: fixture.sessionId,
      expectedRevision: fixture.revision(),
      workspace: { kind: 'host_path', path: cwd },
    },
    context,
  );

  assert.equal(relocationAttempts, 1);
  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'session_busy',
      message: 'Session workspace cannot change while a Turn is active',
    },
  });
});

test('catalog paging stops before the encoded 48 KiB result boundary', async () => {
  const records = Array.from({ length: 32 }, (_, index) => {
    const header = {
      ...sessionHeader(
        `session-${index}`,
        Array.from({ length: 32 }, (_, label) => `label-${label}-${'x'.repeat(110)}`),
      ),
      name: `Session ${index} ${'n'.repeat(280)}`,
    };
    return catalogRecord(header, 1);
  });
  const fixture = createFixture({
    stores: {
      listCatalogPage: async () => ({
        kind: 'page',
        revision: 'sha256:test',
        records,
        hasMore: false,
      }),
    },
  });

  const outcome = await fixture.coordinator.handlers['session.catalog.query'](
    { kind: 'list_start' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.result.kind !== 'page') {
    assert.fail('Catalog query did not return a page');
  }
  assert.ok(outcome.result.sessions.length > 0);
  assert.ok(outcome.result.sessions.length < records.length);
  assert.ok(outcome.result.nextCursor);
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <= SESSION_CATALOG_RESULT_MAX_BYTES,
  );
});

test('rejects a legacy cursor that carries a Session catalog filter', async () => {
  const fixture = createFixture();
  const cursor = Buffer.from(
    JSON.stringify({
      version: 1,
      activityAt: 1,
      sessionId: 'session-1',
      filter: { isArchived: false },
    }),
    'utf8',
  ).toString('base64url');

  const outcome = await fixture.coordinator.handlers['session.catalog.query'](
    {
      kind: 'list_continue',
      revision: 'sha256:test',
      cursor,
    },
    context,
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) assert.fail('Legacy filtered cursor must be rejected');
  assert.equal(outcome.error.code, 'invalid_request');
});

function createFixture(
  options: {
    readonly labels?: readonly string[];
    readonly cwd?: string;
    readonly stores?: Partial<CatalogStores>;
    readonly manager?: Partial<ConfigurationAuthority>;
    readonly continuity?: Partial<SessionContinuity>;
    readonly connection?: FixtureConnection;
    readonly projectCatalog?: ProjectCatalog;
    readonly onProjectChanged?: () => void;
  } = {},
) {
  const sessionId = 'session-1';
  let revision = 3;
  let header = sessionHeader(sessionId, options.labels ?? ['user-label']);
  if (options.cwd) header = { ...header, cwd: options.cwd };
  let drains = 0;

  const stores: CatalogStores = {
    createStableSession: async () => ({
      kind: 'existing',
      record: headerSnapshot(header, revision),
    }),
    listCatalogPage: async () => ({
      kind: 'page',
      revision: 'sha256:test',
      records: [catalogRecord(header, revision)],
      hasMore: false,
    }),
    markSessionReadThroughMessage: async () => headerSnapshot(header, revision),
    probeStableSessionCreate: async () => ({ kind: 'absent' }),
    readCatalogRecord: async () => catalogRecord(header, revision),
    readExecutionBoundary: async () => createGenesisExecutionBoundary('ask'),
    readHeaderRecordSnapshot: async () => headerSnapshot(header, revision),
    readTurnContributionsSnapshot: async () => ({
      throughSequence: null,
      contributions: [],
      nextPosition: null,
    }),
    readTurnLandmarksSnapshot: async () => ({ throughSequence: null, landmarks: [] }),
    updateHeaderVersioned: async (_sessionId, patch, expectedRevision) => {
      if (expectedRevision !== revision) {
        throw new SessionMetadataVersionConflictError(sessionId, expectedRevision, revision);
      }
      header = { ...header, ...patch };
      revision += 1;
      return headerSnapshot(header, revision);
    },
    ...options.stores,
  };
  const runtimePolicy = runtimePolicyFixture(options.connection ?? {});
  const manager: ConfigurationAuthority = {
    transitionSessionConfiguration: async (_sessionId, input) => {
      header = {
        ...header,
        ...input.configuration,
      };
      revision += 1;
      return headerSnapshot(header, revision);
    },
    relocateSessionWorkspace: async (_sessionId, input) => {
      header = {
        ...header,
        cwd: input.cwd,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      };
      revision += 1;
      return headerSnapshot(header, revision);
    },
    ...options.manager,
  };
  const continuity: SessionContinuity = {
    refreshCanonical: async () => undefined,
    ...options.continuity,
  };
  const coordinator = new HostSessionCatalogCoordinator({
    stores,
    runtimePolicy,
    manager,
    admission: new SessionAdmissionGate(),
    continuity,
    workspaceResolver: new HostWorkspaceResolver(
      options.projectCatalog ?? ({ list: async () => [] } as never),
      new HostProjectMembershipGate(),
      options.onProjectChanged ?? (() => undefined),
    ),
    requestDrain: () => {
      drains += 1;
    },
  });
  return {
    coordinator,
    sessionId,
    revision: () => revision,
    header: () => header,
    drainRequests: () => drains,
  };
}

type FixtureConnection = {
  readonly providerType?: 'deepseek' | 'openai' | 'openai-compatible';
  readonly enabledModelIds?: readonly string[];
  readonly models?: readonly { id: string }[];
  readonly relayModelProfiles?: Readonly<Record<string, RelayModelProfile>>;
};

function runtimePolicyFixture(overrides: FixtureConnection): RuntimePolicy {
  const policy = createDefaultRuntimePolicy();
  const connection = {
    connectionId: 'connection-1',
    revision: 1,
    slug: 'test',
    name: 'Test',
    providerType: overrides.providerType ?? ('openai' as const),
    enabled: true,
    enabledModelIds: overrides.enabledModelIds ?? ['model-1'],
    models: overrides.models ?? [{ id: 'model-1' }],
    ...(overrides.relayModelProfiles === undefined
      ? {}
      : { relayModelProfiles: overrides.relayModelProfiles }),
  };
  return {
    connectionCatalog: {
      getSnapshot: async () => ({
        revision: 1,
        defaultTarget: {
          connectionId: connection.connectionId,
          modelId: 'model-1',
        },
        connections: [connection],
      }),
    },
    runtimePolicy: {
      getSnapshot: async () => ({ revision: 1, policy }),
    },
    operations: {
      resolveExecutionConnection: async () => ({
        kind: 'ready',
        connection,
        secretMaterial: {},
        networkProxy: policy.networkProxy,
      }),
    },
  };
}

function configurationInput(
  sessionId: string,
  expectedRevision: number,
): SessionConfigurationUpdateInput {
  return {
    sessionId,
    expectedRevision,
    configuration: {
      modelTarget: {
        kind: 'explicit',
        connectionSlug: 'test',
        model: 'model-1',
      },
      thinkingLevel: null,
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'graph',
    },
  };
}

function sessionHeader(sessionId: string, labels: readonly string[]): SessionHeader {
  return {
    id: sessionId,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    titleIsManual: false,
    isFlagged: false,
    labels: [...labels],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}

function headerSnapshot(header: SessionHeader, revision: number) {
  return { header, revision, committedAt: revision };
}

function catalogRecord(header: SessionHeader, revision: number): SessionCatalogRecord {
  return {
    ...headerSnapshot(header, revision),
    summary: headerToSummary(header),
  };
}
