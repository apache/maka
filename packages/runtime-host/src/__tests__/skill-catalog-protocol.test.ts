/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  SKILL_CATALOG_OPERATION_SPECS,
  SKILL_CATALOG_PAGE_MAX_BYTES,
  SKILL_CATALOG_PAGE_MAX_ITEMS,
  SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES,
  WORKSPACE_HOST_PATH_MAX_BYTES,
  type SkillCatalogBundledItem,
  type SkillCatalogGovernanceItem,
  type SkillCatalogMutation,
  type SkillCatalogPreviewUpdateResult,
  type SkillCatalogRevision,
} from '../protocol/index.js';
import { SkillCatalogRepository } from '../server/skill-catalog-repository.js';

const REVISION = `sha256:${'a'.repeat(64)}` as SkillCatalogRevision;
const NEXT_REVISION = `sha256:${'b'.repeat(64)}` as SkillCatalogRevision;
const CONTEXT = {
  workspace: {
    kind: 'host_path' as const,
    path: process.platform === 'win32' ? 'C:\\workspace\\project' : '/workspace/project',
  },
};
const RESOLVED_WORKSPACE = {
  target: CONTEXT.workspace,
  hostCwd: CONTEXT.workspace.path,
};

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type AssertFalse<Value extends false> = Value;

export type SkillCatalogManagedUpdateMutationTypeContract = [
  AssertFalse<
    IsAssignable<
      {
        kind: 'update_managed';
        ref: 'workspace:legacy:research-brief';
        force: true;
        expectedCurrentSha256: null;
        expectedSourceSha256: null;
      },
      SkillCatalogMutation
    >
  >,
  AssertFalse<
    IsAssignable<
      {
        kind: 'update_managed';
        ref: 'workspace:legacy:research-brief';
        force: false;
        expectedCurrentSha256: SkillCatalogRevision;
        expectedSourceSha256: SkillCatalogRevision;
      },
      SkillCatalogMutation
    >
  >,
];

describe('Runtime Host Skill catalog protocol', () => {
  test('only treats explicit Host-path Skill workspaces as Host-path input', () => {
    assert.equal(
      SKILL_CATALOG_OPERATION_SPECS['skill.catalog.query'].usesHostPaths?.({
        kind: 'start',
        context: { workspace: { kind: 'project', projectId: 'project-1' } },
        view: 'governance',
      }),
      false,
    );
    assert.equal(
      SKILL_CATALOG_OPERATION_SPECS['skill.catalog.query'].usesHostPaths?.({
        kind: 'start',
        context: CONTEXT,
        view: 'governance',
      }),
      true,
    );
    assert.equal(
      SKILL_CATALOG_OPERATION_SPECS['skill.catalog.mutate'].usesHostPaths?.({
        context: { workspace: { kind: 'project', projectId: 'project-1' } },
        expectedRevision: REVISION,
        mutation: { kind: 'create_starter' },
      }),
      false,
    );
    assert.equal(
      SKILL_CATALOG_OPERATION_SPECS['skill.catalog.preview-update'].usesHostPaths?.({
        context: CONTEXT,
        expectedRevision: REVISION,
        ref: 'workspace:legacy:research-brief',
      }),
      true,
    );
  });

  test('decodes bounded Session and new-Session invocable queries and pages', () => {
    for (const input of [
      { kind: 'start', target: { kind: 'session', sessionId: 'session-1' } },
      {
        kind: 'start',
        target: {
          kind: 'new_session',
          context: CONTEXT,
          collaborationMode: 'plan',
          permissionMode: 'bypass',
        },
      },
      {
        kind: 'continue',
        target: { kind: 'session', sessionId: 'session-1' },
        revision: REVISION,
        cursor: 'next',
      },
    ]) {
      assert.deepEqual(
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'skill.catalog.invocable.query',
          input,
        }),
        {
          requestId: 'request-1',
          operation: 'skill.catalog.invocable.query',
          input,
        },
      );
    }
    const result = {
      kind: 'page',
      revision: REVISION,
      items: [
        { ref: 'project:maka:review', id: 'review', name: 'Review', description: 'Review code' },
      ],
      nextCursor: null,
    };
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'skill.catalog.invocable.query',
        ok: true,
        result,
      }),
      {
        requestId: 'request-1',
        operation: 'skill.catalog.invocable.query',
        ok: true,
        result,
      },
    );
    assertInvalidRequest('skill.catalog.invocable.query', {
      kind: 'start',
      target: { kind: 'new_session', context: CONTEXT, collaborationMode: 'plan' },
    });
    assertInvalidRequest('skill.catalog.invocable.query', {
      kind: 'start',
      target: {
        kind: 'new_session',
        context: CONTEXT,
        collaborationMode: 'plan',
        permissionMode: 'unrestricted',
      },
    });
  });

  test('decodes start and continuation queries with bounded workspace context', () => {
    for (const input of [
      {
        kind: 'start',
        context: CONTEXT,
        view: 'governance',
      },
      { kind: 'start', context: CONTEXT, view: 'bundled' },
      {
        kind: 'start',
        context: CONTEXT,
        view: 'managed_sources',
      },
      {
        kind: 'continue',
        context: CONTEXT,
        view: 'governance',
        revision: REVISION,
        cursor: 'opaque:+/cursor==',
      },
    ]) {
      const frame = request('skill.catalog.query', input);
      assert.deepEqual(decodeClientFrame(frame), frame);
    }

    assertInvalidRequest('skill.catalog.query', {
      kind: 'start',
      context: { ...CONTEXT, cwd: '/private' },
      view: 'governance',
    });
    assertInvalidRequest('skill.catalog.query', {
      kind: 'start',
      context: {
        workspace: {
          kind: 'host_path',
          path: '界'.repeat(Math.floor(WORKSPACE_HOST_PATH_MAX_BYTES / 3) + 1),
        },
      },
      view: 'governance',
    });
    for (const projectRoot of ['.', 'project', 'workspace/project']) {
      assertInvalidRequest('skill.catalog.query', {
        kind: 'start',
        context: { workspace: { kind: 'host_path', path: projectRoot } },
        view: 'governance',
      });
    }
    for (const projectRoot of [
      '/workspace/project',
      'C:\\workspace\\project',
      '\\\\server\\share\\project',
    ]) {
      const input = {
        kind: 'start',
        context: { workspace: { kind: 'host_path', path: projectRoot } },
        view: 'governance',
      };
      const frame = request('skill.catalog.query', input);
      assert.deepEqual(decodeClientFrame(frame), frame);
    }
    for (const projectRoot of ['\\workspace\\project', 'C:workspace\\project']) {
      assertInvalidRequest('skill.catalog.query', {
        kind: 'start',
        context: { workspace: { kind: 'host_path', path: projectRoot } },
        view: 'governance',
      });
    }
    assertInvalidRequest('skill.catalog.query', {
      kind: 'continue',
      context: CONTEXT,
      view: 'governance',
      revision: `sha256:${'A'.repeat(64)}`,
      cursor: 'cursor',
    });
    assertInvalidRequest('skill.catalog.query', {
      kind: 'start',
      context: CONTEXT,
      view: 'installed',
    });
  });

  test('decodes metadata-only view-specific pages with fixed nullable governance fields', () => {
    const pages = [
      page('governance', [
        governanceItem(),
        governanceItem({
          kind: 'discovery_diagnostic',
          ref: 'diagnostic:project:maka:0',
          id: 'source-0',
          name: '',
          description: '',
          declaredTools: [],
          sourceType: 'unknown',
          validationStatus: 'metadata_error',
          validationCodes: ['blocked_path'],
          managedUpdateStatus: null,
          enabled: false,
          runtimeStatus: 'disabled',
          scope: 'project',
          source: 'maka',
          contextStatus: 'invalid',
          contextRank: null,
          manageable: false,
        }),
      ]),
      page('bundled', [
        {
          kind: 'bundled',
          id: 'deep-research',
          name: 'Deep research',
          description: 'Research a topic',
          category: 'Productivity',
          declaredTools: ['Read'],
          metadataTruncated: false,
          installed: true,
        },
      ]),
      page('managed_sources', [
        {
          kind: 'managed_source',
          id: 'research-brief',
          name: 'Research brief',
          description: 'Prepare a research brief',
          category: 'Research',
          sourceType: 'local',
          metadataTruncated: false,
          installed: false,
        },
      ]),
    ];
    for (const result of pages) {
      const frame = response('skill.catalog.query', result);
      assert.deepEqual(decodeHostFrame(frame), frame);
    }

    const { managedUpdateStatus: _, ...missingNullable } = governanceItem();
    assertInvalidResponse('skill.catalog.query', page('governance', [missingNullable]));

    for (const forbidden of [
      { ...governanceItem(), path: '/private/SKILL.md' },
      { ...governanceItem(), body: 'private instructions' },
      { ...governanceItem(), contentSha256: REVISION },
    ]) {
      assertInvalidResponse('skill.catalog.query', page('governance', [forbidden]));
    }
    assertInvalidResponse(
      'skill.catalog.query',
      page('bundled', [
        {
          ...(pages[1].items[0] as Record<string, unknown>),
          content: 'private instructions',
        },
      ]),
    );
    assertInvalidResponse(
      'skill.catalog.query',
      page('bundled', [
        {
          ...(pages[1].items[0] as Record<string, unknown>),
          category: '',
        },
      ]),
    );
    assertInvalidResponse('skill.catalog.query', page('bundled', [pages[2].items[0]]));
  });

  test('encodes actual bundled catalog metadata through the Host output codec', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-skill-catalog-protocol-'));
    const dataRoot = join(base, 'data');
    const projectRoot = join(base, 'project');
    const homeDirectory = join(base, 'home');
    const managedSourcesRoot = join(base, 'managed-sources');
    await Promise.all([
      mkdir(dataRoot, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
    ]);
    try {
      const repository = new SkillCatalogRepository({
        runWithRoot: (operation) => operation(dataRoot),
        homeDirectory,
        managedSourcesRoot,
      });
      const result = await repository.query(
        {
          kind: 'start',
          view: 'bundled',
        },
        { projectRoot },
      );
      assert.equal(result.kind, 'page');
      if (result.kind !== 'page') return;

      const bundledItems = result.items.filter(
        (item): item is SkillCatalogBundledItem => item.kind === 'bundled',
      );
      assert.deepEqual(
        bundledItems.map((item) => item.id),
        ['computer-use'],
      );
      assert.equal(
        bundledItems.every((item) => item.category.length > 0),
        true,
      );

      const frame = response('skill.catalog.query', {
        ...result,
        resolvedWorkspace: {
          target: { kind: 'host_path', path: projectRoot },
          hostCwd: projectRoot,
        },
      });
      assert.deepEqual(decodeHostFrame(frame), frame);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('allows bounded human ids in governance while rejecting control-character identities', () => {
    const humanIdPage = page('governance', [
      governanceItem({ id: 'valid skill', ref: 'project:maka:valid skill' }),
    ]);
    assert.deepEqual(
      decodeHostFrame(response('skill.catalog.query', humanIdPage)),
      response('skill.catalog.query', humanIdPage),
    );

    assertInvalidResponse(
      'skill.catalog.query',
      page('governance', [governanceItem({ id: 'bad\nskill' })]),
    );
    assertInvalidResponse(
      'skill.catalog.query',
      page('governance', [governanceItem({ ref: 'project:maka:bad\u0000skill' })]),
    );
    assertInvalidRequest('skill.catalog.mutate', {
      context: CONTEXT,
      expectedRevision: REVISION,
      mutation: { kind: 'install', sourceType: 'managed', sourceId: 'valid skill' },
    });
  });

  test('enforces page item and decoded UTF-8 byte limits', () => {
    assertInvalidResponse(
      'skill.catalog.query',
      page(
        'governance',
        Array.from({ length: SKILL_CATALOG_PAGE_MAX_ITEMS + 1 }, () => governanceItem()),
      ),
    );

    const oversizedPage = page(
      'governance',
      Array.from({ length: 13 }, (_, index) =>
        governanceItem({
          ref: `workspace:legacy:skill-${index}`,
          id: `skill-${index}`,
          description: 'x'.repeat(4096),
        }),
      ),
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversizedPage), 'utf8') > SKILL_CATALOG_PAGE_MAX_BYTES,
    );
    assertInvalidResponse('skill.catalog.query', oversizedPage);

    assertInvalidResponse(
      'skill.catalog.query',
      page('governance', [governanceItem({ description: '界'.repeat(1366) })]),
    );
  });

  test('decodes all mutation variants and requires preview hashes only for force update', () => {
    const maximumLengthId = `s${'a'.repeat(80)}`;
    const mutations: readonly SkillCatalogMutation[] = [
      { kind: 'create_starter' },
      { kind: 'install', sourceType: 'bundled', sourceId: 'deep-research' },
      { kind: 'install', sourceType: 'managed', sourceId: 'research-brief' },
      { kind: 'install', sourceType: 'managed', sourceId: maximumLengthId },
      {
        kind: 'update_managed',
        ref: 'workspace:legacy:research-brief',
        force: false,
        expectedCurrentSha256: null,
        expectedSourceSha256: null,
      },
      {
        kind: 'update_managed',
        ref: 'workspace:legacy:research-brief',
        force: true,
        expectedCurrentSha256: REVISION,
        expectedSourceSha256: NEXT_REVISION,
      },
      { kind: 'delete', ref: 'workspace:legacy:research-brief' },
      { kind: 'set_enabled', ref: 'user:maka:research-brief', enabled: false },
      { kind: 'set_pinned', ref: 'user:maka:research-brief', pinned: true },
    ];
    for (const mutation of mutations) {
      const frame = request('skill.catalog.mutate', {
        context: CONTEXT,
        expectedRevision: REVISION,
        mutation,
      });
      assert.deepEqual(decodeClientFrame(frame), frame);
    }
    assertInvalidRequest('skill.catalog.mutate', {
      context: CONTEXT,
      expectedRevision: REVISION,
      mutation: {
        kind: 'install',
        sourceType: 'managed',
        sourceId: `${maximumLengthId}a`,
      },
    });
    for (const mutation of [
      {
        kind: 'update_managed',
        ref: 'workspace:legacy:research-brief',
        force: true,
        expectedCurrentSha256: null,
        expectedSourceSha256: NEXT_REVISION,
      },
      {
        kind: 'update_managed',
        ref: 'workspace:legacy:research-brief',
        force: false,
        expectedCurrentSha256: REVISION,
        expectedSourceSha256: NEXT_REVISION,
      },
      { kind: 'set_pinned', ref: 'user:maka:research-brief', pinned: true, retry: true },
    ]) {
      assertInvalidRequest('skill.catalog.mutate', {
        context: CONTEXT,
        expectedRevision: REVISION,
        mutation,
      });
    }
  });

  test('decodes mutation outcomes, revision conflicts, and typed rejections', () => {
    for (const result of [
      {
        kind: 'committed',
        revision: NEXT_REVISION,
        entry: governanceItem(),
        resolvedWorkspace: RESOLVED_WORKSPACE,
      },
      {
        kind: 'unchanged',
        revision: REVISION,
        entry: null,
        resolvedWorkspace: RESOLVED_WORKSPACE,
      },
      {
        kind: 'revision_conflict',
        expectedRevision: REVISION,
        actualRevision: NEXT_REVISION,
        resolvedWorkspace: RESOLVED_WORKSPACE,
      },
      { kind: 'rejected', reason: 'blocked_scope', resolvedWorkspace: RESOLVED_WORKSPACE },
      { kind: 'rejected', reason: 'metadata_error', resolvedWorkspace: RESOLVED_WORKSPACE },
    ]) {
      const frame = response('skill.catalog.mutate', result);
      assert.deepEqual(decodeHostFrame(frame), frame);
    }
    assertInvalidResponse('skill.catalog.mutate', {
      kind: 'rejected',
      reason: 'write_failed',
    });
    assertInvalidResponse('skill.catalog.mutate', {
      kind: 'committed',
      revision: NEXT_REVISION,
    });
  });

  test('decodes bounded update previews without baseline content', () => {
    const preview: SkillCatalogPreviewUpdateResult = {
      kind: 'preview',
      revision: REVISION,
      currentSnippet: 'old\ncontent\n',
      sourceSnippet: 'new\ncontent\n',
      currentTruncated: false,
      sourceTruncated: false,
      hasManagedBaseline: true,
      summary: {
        currentLineCount: 2,
        sourceLineCount: 2,
        changedLineCount: 1,
      },
      expectedCurrentSha256: REVISION,
      expectedSourceSha256: NEXT_REVISION,
      resolvedWorkspace: RESOLVED_WORKSPACE,
    };
    const requestFrame = request('skill.catalog.preview-update', {
      context: CONTEXT,
      expectedRevision: REVISION,
      ref: 'workspace:legacy:research-brief',
    });
    assert.deepEqual(decodeClientFrame(requestFrame), requestFrame);
    const responseFrame = response('skill.catalog.preview-update', preview);
    assert.deepEqual(decodeHostFrame(responseFrame), responseFrame);
    const metadataErrorFrame = response('skill.catalog.preview-update', {
      kind: 'rejected',
      reason: 'metadata_error',
      resolvedWorkspace: RESOLVED_WORKSPACE,
    });
    assert.deepEqual(decodeHostFrame(metadataErrorFrame), metadataErrorFrame);

    assertInvalidResponse('skill.catalog.preview-update', {
      ...preview,
      baselineContent: 'must not cross the protocol boundary',
    });
    assertInvalidResponse('skill.catalog.preview-update', {
      ...preview,
      expectedCurrentSha256: 'a'.repeat(64),
    });
    assertInvalidResponse('skill.catalog.preview-update', {
      kind: 'rejected',
      reason: 'preview_too_large',
    });

    const oversized = {
      ...preview,
      currentSnippet: 'x'.repeat(24 * 1024),
      sourceSnippet: 'y'.repeat(24 * 1024),
      currentTruncated: true,
      sourceTruncated: true,
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8') > SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES,
    );
    assertInvalidResponse('skill.catalog.preview-update', oversized);
  });

  test('rejects unknown fields on every result branch', () => {
    for (const [operation, result] of [
      [
        'skill.catalog.query',
        {
          kind: 'revision_changed',
          expectedRevision: REVISION,
          actualRevision: NEXT_REVISION,
          retry: true,
        },
      ],
      [
        'skill.catalog.mutate',
        {
          kind: 'revision_conflict',
          expectedRevision: REVISION,
          actualRevision: NEXT_REVISION,
          retry: true,
        },
      ],
      [
        'skill.catalog.preview-update',
        { kind: 'rejected', reason: 'not_found', detail: '/private/SKILL.md' },
      ],
    ] as const) {
      assertInvalidResponse(operation, result);
    }
  });
});

function governanceItem(
  overrides: Partial<SkillCatalogGovernanceItem> = {},
): SkillCatalogGovernanceItem {
  return {
    kind: 'skill',
    ref: 'workspace:legacy:research-brief',
    id: 'research-brief',
    name: 'Research brief',
    description: 'Prepare a research brief',
    declaredTools: ['Read'],
    metadataTruncated: false,
    sourceType: 'managed',
    userModified: false,
    validationStatus: 'ok',
    validationCodes: [],
    managedUpdateStatus: 'up_to_date',
    enabled: true,
    pinned: false,
    runtimeStatus: 'enabled',
    scope: 'workspace',
    source: 'legacy',
    contextStatus: 'unknown',
    contextRank: null,
    shadowedBy: null,
    needsReview: false,
    manageable: true,
    ...overrides,
  };
}

function page(view: 'governance' | 'bundled' | 'managed_sources', items: readonly unknown[]) {
  return {
    kind: 'page',
    view,
    revision: REVISION,
    items,
    nextCursor: null,
    resolvedWorkspace: RESOLVED_WORKSPACE,
  };
}

function request(operation: string, input: unknown) {
  return { requestId: 'request-1', operation, input };
}

function response(operation: string, result: unknown) {
  return { requestId: 'request-1', operation, ok: true, result };
}

function assertInvalidRequest(operation: string, input: unknown): void {
  assert.throws(() => decodeClientFrame(request(operation, input)), isInvalidFrame);
}

function assertInvalidResponse(operation: string, result: unknown): void {
  assert.throws(() => decodeHostFrame(response(operation, result)), isInvalidFrame);
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
