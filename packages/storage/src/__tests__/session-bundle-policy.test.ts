import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES, type RuntimeEvent } from '@maka/core';
import {
  assertSessionBundleRootLayout,
  exportSessionBundleState,
  planSessionBundleExport,
  type SessionBundleExportError,
} from '../session-bundle-policy.js';
import { createArtifactStore, createArtifactStoreWriteAuthority } from '../artifact-store.js';
import { createSessionStore } from '../session-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

test('exports one session only and excludes credential/config canaries', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    const selected = await sessions.create(sessionInput('Selected'), {
      kind: 'external',
      revision: 0,
    });
    const other = await sessions.create(sessionInput('Other'));
    await sessions.appendMessage(selected.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 10,
      text: 'selected transcript',
    });
    await sessions.close?.();
    const selectedSessionRoot = join(stateRoot, 'sessions', selected.id);
    const portableSessionEntries = [
      ['runs/run-1/run.json', '{"run":"selected"}\n'],
      ['projections/history-compact.json', '{"projection":"selected"}\n'],
      ['turn-admissions/turn-1.json', '{"turn":"selected"}\n'],
      ['shell-runs/shell-1/shell-run.json', '{"shell":"selected"}\n'],
      ['deep-research/events.jsonl', '{"research":"selected"}\n'],
      ['tasks.json', '{"tasks":[]}\n'],
      ['task-events.jsonl', '{"task":"selected"}\n'],
      ['agent-mailbox.jsonl', '{"mail":"selected"}\n'],
      ['plan-events.jsonl', '{"planEvent":"selected"}\n'],
      ['plans.json', '{"plans":[]}\n'],
    ] as const;
    for (const [relativePath, contents] of portableSessionEntries) {
      const path = join(selectedSessionRoot, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    const artifacts = createArtifactStore(stateRoot);
    const selectedArtifact = await artifacts.create({
      id: 'selected-output',
      sessionId: selected.id,
      turnId: 'turn-1',
      name: 'output.txt',
      kind: 'file',
      content: 'session output\n',
      now: 10,
    });
    const otherArtifact = await artifacts.create({
      id: 'other-output',
      sessionId: other.id,
      turnId: 'turn-1',
      name: 'other-output.txt',
      kind: 'file',
      content: 'other output\n',
      now: 11,
    });
    const runtime = createSqliteRuntimeStore(join(stateRoot, 'runtime.sqlite'));
    await runtime.appendRuntimeEvent(
      selected.id,
      'run-1',
      runtimeEvent('event-1', { sessionId: selected.id }),
    );
    await runtime.appendRuntimeEvent(
      other.id,
      'run-2',
      runtimeEvent('event-2', {
        sessionId: other.id,
        runId: 'run-2',
        invocationId: 'run-2',
      }),
    );
    runtime.close();
    await writeFile(join(stateRoot, 'credentials.json'), 'super-secret-api-key');
    await writeFile(join(stateRoot, 'llm-connections.json'), 'host-provider-config');
    await writeFile(join(stateRoot, '.maka_cli_claude_device_id'), 'device-identity');
    await writeFile(join(configRoot, 'credentials.json'), 'config-secret-canary');

    const plan = await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: selected.id,
    });

    assert.deepEqual(plan.includedEntries, ['artifacts', 'runtime.sqlite', 'sessions']);
    assert.deepEqual(
      [...plan.excludedEntries].sort(),
      [
        '.maka_cli_claude_device_id',
        'credentials.json',
        'llm-connections.json',
        'sessions.sqlite',
        `artifacts/${other.id}`,
        `sessions/${other.id}`,
      ].sort(),
    );
    const exportedTranscript = await readFile(
      join(destinationRoot, 'sessions', selected.id, 'session.jsonl'),
      'utf8',
    );
    const [exportedHeader, exportedMessage] = exportedTranscript
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(exportedHeader.id, selected.id);
    assert.equal(exportedHeader.name, 'Selected');
    assert.equal(exportedHeader.type, undefined);
    assert.equal(exportedMessage.text, 'selected transcript');
    for (const [relativePath, contents] of portableSessionEntries) {
      assert.equal(
        await readFile(join(destinationRoot, 'sessions', selected.id, relativePath), 'utf8'),
        contents,
      );
    }
    await assert.rejects(readFile(join(destinationRoot, 'sessions', other.id, 'session.jsonl')));
    await assert.rejects(readFile(join(destinationRoot, 'sessions.sqlite')));
    await assert.rejects(readFile(join(destinationRoot, 'artifacts', otherArtifact.relativePath)));
    assert.match(
      await readFile(join(destinationRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
      new RegExp(`"sessionId":"${selected.id}"`),
    );
    assert.doesNotMatch(
      await readFile(join(destinationRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
      new RegExp(other.id),
    );
    const reopenedArtifacts = createArtifactStore(destinationRoot);
    assert.deepEqual(await reopenedArtifacts.list(selected.id), [selectedArtifact]);
    assert.deepEqual(await reopenedArtifacts.list(other.id), []);
    assert.deepEqual(await reopenedArtifacts.readText(selectedArtifact.id), {
      ok: true,
      text: 'session output\n',
    });
    const exportedRuntime = createSqliteRuntimeStore(join(destinationRoot, 'runtime.sqlite'));
    try {
      assert.equal((await exportedRuntime.readSessionRuntimeEvents(selected.id)).length, 1);
      assert.equal((await exportedRuntime.readSessionRuntimeEvents(other.id)).length, 0);
    } finally {
      exportedRuntime.close();
    }
    await assert.rejects(readFile(join(destinationRoot, 'credentials.json'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, 'llm-connections.json'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, '.maka_cli_claude_device_id'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, '.maka-artifact-writer.lock'), 'utf8'));
    assert.equal(
      await readFile(join(configRoot, 'credentials.json'), 'utf8'),
      'config-secret-canary',
    );
    const restoredSessions = createSessionStore(destinationRoot);
    try {
      assert.equal((await restoredSessions.readExecutionBoundary(selected.id)).kind, 'external');
    } finally {
      await restoredSessions.close?.();
    }
    await assert.rejects(
      readFile(join(destinationRoot, 'sessions', selected.id, 'execution-boundary.json'), 'utf8'),
    );
  });
});

test('exports while the session metadata WAL remains open and protects its sidecars', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    try {
      const selected = await sessions.create(sessionInput('Selected'));
      await sessions.appendMessage(selected.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'selected transcript',
      });

      const sidecars = ['sessions.sqlite-wal', 'sessions.sqlite-shm'];
      const liveEntries = await readdir(stateRoot);
      for (const sidecar of sidecars) {
        assert.ok(liveEntries.includes(sidecar), liveEntries.join(', '));
      }

      const planned = await planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: selected.id,
      });
      for (const sidecar of sidecars) {
        assert.ok(planned.excludedEntries.includes(sidecar), JSON.stringify(planned));
      }

      const exported = await exportSessionBundleState({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: selected.id,
      });
      for (const sidecar of sidecars) {
        assert.ok(exported.excludedEntries.includes(sidecar), JSON.stringify(exported));
        await assert.rejects(readFile(join(destinationRoot, sidecar)));
      }
      assert.match(
        await readFile(join(destinationRoot, 'sessions', selected.id, 'session.jsonl'), 'utf8'),
        /selected transcript/,
      );
    } finally {
      await sessions.close?.();
    }
  });
});

test('restores the accumulated managed boundary from a session bundle', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    const selected = await sessions.create(sessionInput('Selected'));
    await sessions.createSandboxBoundaryRequest({
      sessionId: selected.id,
      requestId: 'request-1',
      turnId: 'turn-1',
      expansion: {
        filesystem: {
          entries: [{ path: '/outside/selected.txt', access: 'write', scope: 'exact' }],
        },
      },
      justification: 'Write the selected output.',
    });
    await sessions.settleSandboxBoundaryRequest({
      sessionId: selected.id,
      requestId: 'request-1',
      decision: 'allow',
    });
    const sourceBoundary = await sessions.readExecutionBoundary(selected.id);
    await sessions.close?.();

    await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: selected.id,
    });
    const restoredSessions = createSessionStore(destinationRoot);
    try {
      const restoredBoundary = await restoredSessions.readExecutionBoundary(selected.id);
      assert.equal(sourceBoundary.kind, 'managed');
      assert.equal(restoredBoundary.kind, 'managed');
      if (sourceBoundary.kind !== 'managed' || restoredBoundary.kind !== 'managed') return;
      assert.deepEqual(restoredBoundary.profile, sourceBoundary.profile);
      assert.equal(restoredBoundary.revision, 0);
    } finally {
      await restoredSessions.close?.();
    }
  });
});

test('round-trips a cumulative boundary larger than one expansion payload', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    const selected = await sessions.create(sessionInput('Selected'));
    for (let request = 0; request < 3; request += 1) {
      const requestId = `request-${request}`;
      await sessions.createSandboxBoundaryRequest({
        sessionId: selected.id,
        requestId,
        turnId: 'turn-1',
        expansion: {
          filesystem: {
            entries: Array.from({ length: 32 }, (_, entry) => ({
              path: `/outside/${request}/${entry}-${'x'.repeat(700)}`,
              access: 'read' as const,
              scope: 'exact' as const,
            })),
          },
        },
        justification: 'Read generated inputs.',
      });
      await sessions.settleSandboxBoundaryRequest({
        sessionId: selected.id,
        requestId,
        decision: 'allow',
      });
    }
    const sourceBoundary = await sessions.readExecutionBoundary(selected.id);
    await sessions.close?.();

    await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: selected.id,
    });
    const transferPath = join(destinationRoot, 'sessions', selected.id, 'execution-boundary.json');
    assert.ok((await lstat(transferPath)).size > MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES);

    const restoredSessions = createSessionStore(destinationRoot);
    try {
      const restoredBoundary = await restoredSessions.readExecutionBoundary(selected.id);
      assert.equal(sourceBoundary.kind, 'managed');
      assert.equal(restoredBoundary.kind, 'managed');
      if (sourceBoundary.kind !== 'managed' || restoredBoundary.kind !== 'managed') return;
      assert.deepEqual(restoredBoundary.profile, sourceBoundary.profile);
    } finally {
      await restoredSessions.close?.();
    }
  });
});

test('fails closed on unknown top-level state entries', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    await writeFile(join(stateRoot, 'new-secret-store.json'), 'unknown-secret');

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId: 'session-1' }),
      'unknown_entry',
    );
  });
});

test('requires Artifact authority recovery for selected-session payloads absent from metadata', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    const artifacts = createArtifactStore(stateRoot);
    await artifacts.create({
      id: 'canonical-artifact',
      sessionId,
      turnId: 'turn-1',
      name: 'canonical.txt',
      kind: 'file',
      content: 'canonical payload\n',
      now: 1,
    });
    const orphanRelativePath = `artifacts/${sessionId}/orphan-payload.txt`;
    await writeFile(join(stateRoot, orphanRelativePath), 'orphan payload\n');

    await assertArtifactRecoveryRequired(
      exportSessionBundleState({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId,
      }),
      orphanRelativePath,
    );
  });
});

test('fails closed on unknown directories in the selected Artifact payload root', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    const artifacts = createArtifactStore(stateRoot);
    await artifacts.create({
      id: 'canonical-artifact',
      sessionId,
      turnId: 'turn-1',
      name: 'canonical.txt',
      kind: 'file',
      content: 'canonical payload\n',
      now: 1,
    });
    await mkdir(join(stateRoot, 'artifacts', sessionId, 'unclassified-directory'));

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
      'unknown_entry',
    );
  });
});

test('requires Artifact authority recovery for canonical transaction residue', async (t) => {
  const residueStates = [
    'publication staging with linked target',
    'purge intent with live payload and metadata',
    'purge intent temp with live payload and metadata',
    'metadata temp with uncommitted target metadata',
  ] as const;

  for (const residueState of residueStates) {
    await t.test(residueState, async () => {
      await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
        const sessionId = await createSelectedSession(stateRoot);
        const residuePath = await createArtifactTransactionResidue(
          stateRoot,
          sessionId,
          residueState,
        );

        const expectedResidue =
          residueState === 'metadata temp with uncommitted target metadata'
            ? undefined
            : residuePath;
        await assertArtifactRecoveryRequired(
          planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
          expectedResidue,
        );
        await assertArtifactRecoveryRequired(
          exportSessionBundleState({ stateRoot, configRoot, destinationRoot, sessionId }),
          expectedResidue,
        );
        await assert.rejects(readdir(destinationRoot), { code: 'ENOENT' });
      });
    });
  }
});

test('authority recovery removes canonical root temps before bundle export', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    const artifacts = createArtifactStore(stateRoot);
    const record = await artifacts.create({
      id: 'canonical-artifact',
      sessionId,
      turnId: 'turn-1',
      name: 'canonical.txt',
      kind: 'file',
      content: 'canonical payload\n',
      now: 1,
    });
    const artifactRoot = join(stateRoot, 'artifacts');
    const uuid = '00000000-0000-4000-8000-000000000000';
    const tempPaths = [
      join(artifactRoot, `metadata.jsonl.123.${uuid}.tmp`),
      join(artifactRoot, 'metadata.jsonl.123.1700000000000.tmp'),
      join(artifactRoot, `.artifact-purge-intent.json.123.${uuid}.tmp`),
    ];
    await writeFile(tempPaths[0]!, await readFile(join(artifactRoot, 'metadata.jsonl')));
    await writeFile(tempPaths[1]!, await readFile(join(artifactRoot, 'metadata.jsonl')));
    await writeFile(tempPaths[2]!, JSON.stringify({ schemaVersion: 1, artifactIds: [record.id] }));

    await assertArtifactRecoveryRequired(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
    );
    const authority = createArtifactStoreWriteAuthority(stateRoot);
    await authority.recover();
    for (const tempPath of tempPaths) {
      await assert.rejects(lstat(tempPath), { code: 'ENOENT' });
    }

    await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId,
    });
    assert.deepEqual(await createArtifactStore(destinationRoot).list(sessionId), [record]);
    assert.deepEqual(await createArtifactStore(destinationRoot).readText(record.id), {
      ok: true,
      text: 'canonical payload\n',
    });
  });
});

test('requires Artifact authority recovery for publication residue in another session', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const selectedSessionId = await createSelectedSession(stateRoot);
    const otherSessionId = await createSelectedSession(stateRoot);
    const residuePath = await createArtifactTransactionResidue(
      stateRoot,
      otherSessionId,
      'publication staging with linked target',
    );

    await assertArtifactRecoveryRequired(
      planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: selectedSessionId,
      }),
      residuePath,
    );
  });
});

test('fails closed on Artifact residue lookalikes with invalid names', async () => {
  const invalidEntries = [
    {
      relativePath: 'artifacts/.artifact-purge-intent.json.123.not-a-uuid.tmp',
      insideSelectedSession: false,
    },
    {
      relativePath: 'artifacts/metadata.jsonl.123.not-a-uuid.tmp',
      insideSelectedSession: false,
    },
    {
      relativePath: `.artifact-publish.${'a'.repeat(64)}.not-a-uuid.tmp`,
      insideSelectedSession: true,
    },
  ] as const;

  for (const invalid of invalidEntries) {
    await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
      const sessionId = await createSelectedSession(stateRoot);
      const artifactRoot = join(stateRoot, 'artifacts');
      const relativePath = invalid.insideSelectedSession
        ? `artifacts/${sessionId}/${invalid.relativePath}`
        : invalid.relativePath;
      await mkdir(dirname(join(stateRoot, relativePath)), { recursive: true });
      await writeFile(join(stateRoot, relativePath), 'not valid residue\n');

      await assertExportError(
        planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
        'unknown_entry',
      );
    });
  }
});

test('rejects every Artifact metadata file that the Artifact store cannot reopen', async (t) => {
  const corruptions: ReadonlyArray<{
    name: string;
    apply: (records: Array<Record<string, unknown>>) => unknown[];
  }> = [
    {
      name: 'unknown field in an unselected session',
      apply: (records) => [records[0], { ...records[1], hostSecret: 'must-not-export' }],
    },
    {
      name: 'invalid kind in an unselected session',
      apply: (records) => [records[0], { ...records[1], kind: 'archive' }],
    },
    {
      name: 'path that does not match the record identity',
      apply: (records) => [
        { ...records[0], relativePath: `${String(records[0]?.sessionId)}/wrong-name.txt` },
        records[1],
      ],
    },
    {
      name: 'name that the Artifact writer could not persist',
      apply: (records) => {
        const selected = records[0]!;
        return [
          {
            ...selected,
            name: 'invalid/name.txt',
            relativePath: `${String(selected.sessionId)}/${String(selected.id)}-invalid/name.txt`,
          },
          records[1],
        ];
      },
    },
    {
      name: 'duplicate artifact id',
      apply: (records) => [records[0], records[1], { ...records[0] }],
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
        const selectedSessionId = await createSelectedSession(stateRoot);
        const otherSessionId = await createSelectedSession(stateRoot);
        const artifacts = createArtifactStore(stateRoot);
        await artifacts.create({
          id: 'selected-artifact',
          sessionId: selectedSessionId,
          turnId: 'turn-1',
          name: 'selected.txt',
          kind: 'file',
          content: 'selected\n',
          now: 1,
        });
        await artifacts.create({
          id: 'other-artifact',
          sessionId: otherSessionId,
          turnId: 'turn-1',
          name: 'other.txt',
          kind: 'file',
          content: 'other\n',
          now: 2,
        });

        const metadataPath = join(stateRoot, 'artifacts', 'metadata.jsonl');
        const records = (await readFile(metadataPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const corrupted = corruption.apply(records);
        await writeFile(
          metadataPath,
          `${corrupted.map((record) => JSON.stringify(record)).join('\n')}\n`,
        );

        await assert.rejects(
          () => createArtifactStore(stateRoot).list(selectedSessionId),
          /Invalid artifact metadata line/,
        );
        await assertArtifactMetadataRejected(
          exportSessionBundleState({
            stateRoot,
            configRoot,
            destinationRoot,
            sessionId: selectedSessionId,
          }),
        );
      });
    });
  }
});

test('fails closed on unknown entries inside the selected session', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    await writeFile(
      join(stateRoot, 'sessions', sessionId, 'unclassified-cache.json'),
      '{"secret":"must-not-export"}\n',
    );

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
      'unknown_entry',
    );
  });
});

test('fails closed on symlinked state entries and path escape', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot, root }) => {
    const outside = join(root, 'outside-secret.txt');
    await writeFile(outside, 'outside-secret');
    const sessionId = await createSelectedSession(stateRoot);
    await symlink(outside, join(stateRoot, 'sessions', sessionId, 'escaped.txt'));

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
      'symlink',
    );
  });
});

test('rejects a missing state root without creating it', async () => {
  await withBundleRoots(async ({ root, configRoot, destinationRoot }) => {
    const stateRoot = join(root, 'missing-state');

    await assertExportError(
      exportSessionBundleState({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: 'missing-session',
      }),
      'invalid_root',
    );
    await assert.rejects(lstat(stateRoot), { code: 'ENOENT' });
  });
});

test('rejects a symlinked state root without modifying its target', async () => {
  await withBundleRoots(async ({ root, stateRoot, configRoot, destinationRoot }) => {
    await createSelectedSession(stateRoot);
    const linkedRoot = join(root, 'linked-state');
    await symlink(stateRoot, linkedRoot);

    await assertExportError(
      exportSessionBundleState({
        stateRoot: linkedRoot,
        configRoot,
        destinationRoot,
        sessionId: 'missing-session',
      }),
      'symlink',
    );
    await assert.rejects(lstat(join(stateRoot, '.maka-artifact-writer.lock')), { code: 'ENOENT' });
  });
});

test('rejects unsafe root overlap while allowing explicit legacy sharing', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot }) => {
    await assertSessionBundleRootLayout({ stateRoot, configRoot });
    await assertSessionBundleRootLayout({
      stateRoot,
      configRoot: stateRoot,
      allowShared: true,
    });

    await assertExportError(
      assertSessionBundleRootLayout({
        stateRoot,
        configRoot: join(stateRoot, 'config'),
      }),
      'overlapping_roots',
    );
  });
});

test('rejects a bundle destination nested inside a source root', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot }) => {
    await assertExportError(
      planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot: join(stateRoot, 'bundle'),
        sessionId: 'session-1',
      }),
      'overlapping_roots',
    );
  });
});

test('preserves the complete suffix for a deeply missing destination path', async () => {
  await withBundleRoots(async ({ root, stateRoot, configRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    const destinationRoot = join(root, 'missing', 'deep', 'bundle');
    const plan = await planSessionBundleExport({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId,
    });
    assert.equal(plan.destinationRoot, resolve(await realpath(root), 'missing', 'deep', 'bundle'));
  });
});

test('fails closed when the state root contains no sessions', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    await assertExportError(
      planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: 'missing-session',
      }),
      'invalid_root',
    );
  });
});

async function assertExportError(
  operation: Promise<unknown>,
  code: SessionBundleExportError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as SessionBundleExportError).code, code);
    return true;
  });
}

async function assertArtifactRecoveryRequired(
  operation: Promise<unknown>,
  relativePath?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    const exportError = error as SessionBundleExportError;
    assert.equal(exportError.code, 'unsupported_entry');
    assert.match(exportError.message, /Artifact write authority recovery is required/);
    if (relativePath !== undefined) {
      assert.match(exportError.message, new RegExp(escapeRegExp(relativePath)));
    }
    return true;
  });
}

async function assertArtifactMetadataRejected(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    const exportError = error as SessionBundleExportError;
    assert.equal(exportError.code, 'unsupported_entry');
    assert.match(exportError.message, /cannot be reopened by the Artifact store/);
    assert.match(
      String((exportError as Error & { cause?: unknown }).cause),
      /Invalid artifact metadata line \d+/,
    );
    return true;
  });
}

async function createArtifactTransactionResidue(
  stateRoot: string,
  sessionId: string,
  residueState:
    | 'publication staging with linked target'
    | 'purge intent with live payload and metadata'
    | 'purge intent temp with live payload and metadata'
    | 'metadata temp with uncommitted target metadata',
): Promise<string> {
  const artifactRoot = join(stateRoot, 'artifacts');
  const sessionArtifactRoot = join(artifactRoot, sessionId);
  const targetName = 'artifact-1-output.txt';
  const targetPath = join(sessionArtifactRoot, targetName);
  const relativeTargetPath = `${sessionId}/${targetName}`;
  const payload = 'transactional artifact\n';
  const metadata = `${JSON.stringify({
    id: 'artifact-1',
    sessionId,
    turnId: 'turn-1',
    createdAt: 1,
    name: 'output.txt',
    kind: 'file',
    relativePath: relativeTargetPath,
    sizeBytes: Buffer.byteLength(payload),
    status: 'live',
  })}\n`;
  const uuid = '00000000-0000-4000-8000-000000000000';
  await mkdir(sessionArtifactRoot, { recursive: true });

  if (residueState === 'publication staging with linked target') {
    const targetHash = createHash('sha256').update(targetName).digest('hex');
    const stagingName = `.artifact-publish.${targetHash}.${uuid}.tmp`;
    const stagingPath = join(sessionArtifactRoot, stagingName);
    await writeFile(stagingPath, payload);
    await link(stagingPath, targetPath);
    await writeFile(join(artifactRoot, 'metadata.jsonl'), '');
    return `artifacts/${sessionId}/${stagingName}`;
  }

  await writeFile(targetPath, payload);
  if (residueState === 'metadata temp with uncommitted target metadata') {
    const metadataTempName = `metadata.jsonl.123.${uuid}.tmp`;
    await writeFile(join(artifactRoot, 'metadata.jsonl'), '');
    await writeFile(join(artifactRoot, metadataTempName), metadata);
    return `artifacts/${metadataTempName}`;
  }

  await writeFile(join(artifactRoot, 'metadata.jsonl'), metadata);
  const purgeIntent = JSON.stringify({ schemaVersion: 1, artifactIds: ['artifact-1'] });
  if (residueState === 'purge intent with live payload and metadata') {
    await writeFile(join(artifactRoot, '.artifact-purge-intent.json'), purgeIntent);
    return 'artifacts/.artifact-purge-intent.json';
  }

  const purgeIntentTempName = `.artifact-purge-intent.json.123.${uuid}.tmp`;
  await writeFile(join(artifactRoot, purgeIntentTempName), purgeIntent);
  return `artifacts/${purgeIntentTempName}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: id },
    ...overrides,
  };
}

function sessionInput(name: string) {
  return {
    cwd: '/repo',
    backend: 'fake' as const,
    llmConnectionSlug: 'fixture',
    model: 'fixture-model',
    permissionMode: 'execute' as const,
    name,
  };
}

async function createSelectedSession(stateRoot: string): Promise<string> {
  const sessions = createSessionStore(stateRoot);
  try {
    return (await sessions.create(sessionInput('Selected'))).id;
  } finally {
    await sessions.close?.();
  }
}

async function withBundleRoots(
  fn: (roots: {
    root: string;
    stateRoot: string;
    configRoot: string;
    destinationRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-'));
  const stateRoot = join(root, 'state');
  const configRoot = join(root, 'config');
  const destinationRoot = join(root, 'export');
  await Promise.all([mkdir(stateRoot), mkdir(configRoot)]);
  try {
    await fn({ root, stateRoot, configRoot, destinationRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
