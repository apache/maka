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
// Electron boundary: actual preload → main → elected dev Host → SQLite/Gitoxide.
// Unlike standard E2E this does not install a fake Runtime/backend.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';
import {
  resolveStorageRoot,
  resolveExistingStorageRootControlDirectory,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { createSettingsStore } from '@maka/storage/settings-store';
import { buildFixtureEnv } from './fixture-env.mjs';
import { closeElectronApplication } from './electron-lifecycle.mjs';
import { armCandidateBreakpoint } from './desktop-managed-candidate-breakpoint.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
assert.ok(helperPath, 'Set MAKA_GITOXIDE_HELPER_PATH to the built native helper');
const executablePath = await realpath(helperPath);
const bytes = await readFile(executablePath);
const root = await mkdtemp(join(tmpdir(), 'maka-managed-electron-'));
const userData = join(root, 'user-data');
const workspace = join(userData, 'workspaces', 'default');
const source = join(root, 'source');
const home = join(root, 'home');
await Promise.all([mkdir(source), mkdir(home), mkdir(userData)]);
console.log(`Evidence directory: ${root}`);
const git = (...args) =>
  promisify(execFile)('git', ['-C', source, ...args], { timeout: 10000, windowsHide: true });
await git('init', '--object-format=sha1');
await writeFile(join(source, 'tracked.txt'), 'baseline\n');
await git('add', 'tracked.txt');
await git(
  '-c',
  'user.name=Smoke',
  '-c',
  'user.email=smoke@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-m',
  'baseline',
);
const requests = [];
const failedBeforeTerminal = process.argv.includes('--failed-before-terminal');
const failedResultInterrupt = process.argv.includes('--failed-result-interrupt');
const repeatInterrupt = process.argv.includes('--repeat-interrupt');
const candidateEditInterrupt = process.argv.includes('--candidate-edit-interrupt');
const candidateNoopInterrupt = process.argv.includes('--candidate-noop-interrupt');
assert.ok(
  [
    failedBeforeTerminal,
    failedResultInterrupt,
    candidateEditInterrupt,
    candidateNoopInterrupt,
    process.argv.includes('--candidate-interrupt'),
  ].filter(Boolean).length <= 1,
  'Choose one candidate interruption scenario',
);
const candidateInterrupt =
  failedBeforeTerminal ||
  candidateEditInterrupt ||
  candidateNoopInterrupt ||
  process.argv.includes('--candidate-interrupt');
const candidateToolName = candidateEditInterrupt || failedBeforeTerminal ? 'Edit' : 'Write';
// Manual real-process breakpoint test; does not claim arbitrary-instruction crash coverage.
assert.ok(
  !((candidateInterrupt || failedResultInterrupt) && repeatInterrupt),
  'Candidate interruption is a single-restart test',
);
const interruptTurn =
  failedResultInterrupt ||
  candidateInterrupt ||
  repeatInterrupt ||
  process.argv.includes('--interrupt-turn');
const expectedContent =
  failedBeforeTerminal || failedResultInterrupt || candidateNoopInterrupt
    ? /baseline/
    : candidateInterrupt && !candidateEditInterrupt
      ? /written/
      : /edited/;
let restartNumber = 0;
let waitingForCompletion = false;
let operationStep = 0;
const operations = [
  ...(failedBeforeTerminal || failedResultInterrupt
    ? [
        {
          name: 'Edit',
          input: { path: 'tracked.txt', old_string: 'ABSENT_PATTERN', new_string: 'unexpected' },
        },
      ]
    : candidateNoopInterrupt
      ? [{ name: 'Write', input: { path: 'tracked.txt', content: 'baseline\n' } }]
      : candidateEditInterrupt
        ? [
            {
              name: 'Edit',
              input: { path: 'tracked.txt', old_string: 'baseline', new_string: 'edited' },
            },
          ]
        : [
            { name: 'Write', input: { path: 'tracked.txt', content: 'written\n' } },
            {
              name: 'Edit',
              input: { path: 'tracked.txt', old_string: 'written', new_string: 'edited' },
            },
          ]),
  { name: 'Read', input: { path: 'tracked.txt' } },
];
let restarted = false;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) {
      res.writeHead(413).end();
      return;
    }
  }
  const body = JSON.parse(raw || '{}');
  requests.push({ path: req.url, body });
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'smoke-title',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'Managed files smoke task' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    return;
  }
  if (
    interruptTurn &&
    ((!restarted && operationStep === operations.length) ||
      (repeatInterrupt && restartNumber === 1 && operationStep === 1))
  ) {
    // A real model request containing all tool results is our observable barrier.
    // Leave the response open: the turn cannot finish before the Host is killed.
    waitingForCompletion = true;
    return;
  }
  const operation = restarted
    ? operationStep++ === 0
      ? { name: 'Read', input: { path: 'tracked.txt' } }
      : undefined
    : operations[operationStep++];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: `smoke-${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  if (operation) {
    event('content_block_start', {
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `smoke-tool-${restartNumber}-${operationStep}`,
        name: operation.name,
        input: {},
      },
    });
    event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(operation.input) },
    });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', {
      index: 0,
      delta: {
        type: 'text_delta',
        text: restarted ? 'MANAGED_DESKTOP_REOPEN_OK' : 'MANAGED_DESKTOP_SMOKE_OK',
      },
    });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: operation ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event('message_stop', {});
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
let page;
let candidateDebugger;
let candidateEvidence;
const logs = [];
try {
  const capability = await resolveStorageRoot({ path: workspace, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const catalog = await stores.connectionCatalog.getSnapshot();
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: 'smoke',
        name: 'Local smoke model',
        providerType: 'anthropic',
        enabled: true,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        enabledModelIds: ['claude-sonnet-4-5-20250929'],
      },
    });
    assert.equal(created.kind, 'committed');
    const connection = created.snapshot.connections.find((item) => item.slug === 'smoke');
    assert.ok(connection);
    assert.equal(
      (
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'local-smoke-only',
        })
      ).kind,
      'committed',
    );
    const fetch = await stores.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    const models = await stores.operations.completeModelFetch(fetch.ticket, {
      models: [{ id: 'claude-sonnet-4-5-20250929' }],
      source: 'fallback',
      fetchedAt: 0,
    });
    assert.equal(models.kind, 'committed');
    assert.equal(
      (
        await stores.connectionCatalog.setDefaultTarget({
          expectedCatalogRevision: models.snapshot.revision,
          target: { connectionId: connection.connectionId, modelId: 'claude-sonnet-4-5-20250929' },
        })
      ).kind,
      'committed',
    );
  } finally {
    await owner.close();
  }
  const catalog = createProjectCatalog(workspace);
  const project = await catalog.register(source);
  await writeFile(
    join(workspace, 'project-preferences.json'),
    JSON.stringify({ version: 1, selections: { [capability.rootId]: project.id } }),
  );
  await createSettingsStore(workspace).update({ personalization: { uiLocale: 'en' } });
  const env = buildFixtureEnv(userData, home);
  // Exercise the shipped/default resume gate, not a developer's inherited opt-in.
  delete env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME;
  for (const key of Object.keys(env)) if (key.startsWith('MAKA_E2E')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  env.MAKA_MANAGED_SMOKE_ROOT = root;
  delete env.MAKA_MANAGED_SMOKE_DEBUG_HOST;
  if (candidateInterrupt) env.MAKA_MANAGED_SMOKE_DEBUG_HOST = '1';
  env.MAKA_MANAGED_FILES_DEV_HELPER = JSON.stringify({
    schemaVersion: 1,
    executablePath,
    expectedBytes: bytes.length,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    platform: process.platform,
    arch: process.arch,
  });
  app = await electron.launch({
    args: [join(repo, 'scripts/desktop-managed-smoke-entry.cjs')],
    cwd: join(repo, 'apps/desktop'),
    env,
    timeout: 30000,
  });
  app.process().stderr?.on('data', (chunk) => logs.push(chunk.toString()));
  await expect
    .poll(
      () => {
        page = app.windows().find((candidate) => {
          const url = candidate.url();
          return url.includes('/index.html') && !url.includes('surface=');
        });
        return Boolean(page);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(page.locator('.maka-composer-editor [contenteditable="true"]')).toBeVisible({
    timeout: 30000,
  });
  await page.locator('.maka-composer-plus-menu').click();
  await page.getByRole('menuitemcheckbox', { name: 'Managed files task' }).click();
  await page.keyboard.press('Escape');
  await page
    .locator('.maka-composer-editor [contenteditable="true"]')
    .fill(
      failedBeforeTerminal || failedResultInterrupt
        ? 'Attempt an Edit of ABSENT_PATTERN in tracked.txt, report the failure, then read tracked.txt.'
        : candidateNoopInterrupt
          ? 'Write tracked.txt with its current baseline content, then read it.'
          : candidateEditInterrupt
            ? 'Edit tracked.txt from baseline to edited, then read it.'
            : 'Write tracked.txt to written, edit written to edited, then read it.',
    );
  await expect(page.locator('.maka-composer button[type="submit"]')).toBeEnabled();
  if (candidateInterrupt)
    candidateDebugger = await armCandidateBreakpoint(
      root,
      repo,
      failedBeforeTerminal ? 'failure' : candidateNoopInterrupt ? 'no_change' : 'successor',
    );
  await page.locator('.maka-composer button[type="submit"]').click();
  if (candidateInterrupt) {
    const breakpoint = await candidateDebugger.wait();
    const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
    try {
      const events = db
        .prepare('SELECT payload_json FROM runtime_events ORDER BY rowid')
        .all()
        .map(({ payload_json }) => JSON.parse(payload_json));
      const dispatch = events.find((event) => event.actions?.toolDispatch?.managedMutation);
      assert.ok(dispatch, 'Paused Host must have a durable T1');
      const operationId = dispatch.actions.toolDispatch.operationId;
      assert.ok(
        events.some(
          (event) =>
            event.refs?.operationId === operationId &&
            event.content?.kind === 'function_call' &&
            event.content.name === candidateToolName,
        ),
      );
      assert.equal(
        events.some(
          (event) =>
            event.refs?.operationId === operationId && event.content?.kind === 'function_response',
        ),
        false,
        'T2 must not exist at the breakpoint',
      );
      assert.equal(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM runtime_managed_mutation_reservations WHERE operation_id = ?',
          )
          .get(operationId).count,
        1,
      );
      candidateEvidence = {
        heads: db.prepare('SELECT * FROM runtime_workspace_heads ORDER BY workspace_id').all(),
        toolName: candidateToolName,
        operationId,
        sessionId: dispatch.sessionId,
        turnId: dispatch.turnId,
        dispatchId: dispatch.id,
        breakpoint,
        before: events,
      };
    } finally {
      db.close();
    }
    if (!failedBeforeTerminal) {
      const candidateRefPath = join(
        workspace,
        `managed-files-${createHash('sha256').update(candidateEvidence.sessionId).digest('hex')}.git`,
        'refs',
        'maka',
        'candidates',
        createHash('sha256').update(candidateEvidence.operationId).digest('hex'),
      );
      await expect
        .poll(
          async () => {
            try {
              candidateEvidence.candidateCommitOid = (
                await readFile(candidateRefPath, 'utf8')
              ).trim();
              return /^[a-f0-9]{40}$/.test(candidateEvidence.candidateCommitOid);
            } catch (error) {
              if (error.code === 'ENOENT') return false;
              throw error;
            }
          },
          { timeout: 10000, intervals: [10, 25, 50] },
        )
        .toBe(true);
    }
    await writeFile(
      join(root, 'candidate-before-kill.json'),
      JSON.stringify(candidateEvidence, null, 2),
    );
  } else if (interruptTurn) {
    await expect.poll(() => waitingForCompletion, { timeout: 30000 }).toBe(true);
  } else {
    await expect(page.getByText('MANAGED_DESKTOP_SMOKE_OK', { exact: true })).toBeVisible({
      timeout: 30000,
    });
  }
  assert.ok(requests.length > 0);
  const finalRequest = requests.filter(({ body }) => body.stream).at(-1);
  const results = finalRequest.body.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === 'tool_result');
  assert.equal(results.length, candidateInterrupt ? 0 : failedResultInterrupt ? 2 : 3);
  assert.equal(results.filter((result) => result.is_error).length, failedResultInterrupt ? 1 : 0);
  if (!candidateInterrupt) assert.match(JSON.stringify(results.at(-1)), expectedContent);
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'baseline\n');
  await page.screenshot({ path: join(root, 'desktop.png') });
  const readMutations = () => {
    const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
    try {
      return db
        .prepare('SELECT payload_json FROM runtime_events ORDER BY rowid')
        .all()
        .map(({ payload_json }) => JSON.parse(payload_json))
        .filter(
          (event) =>
            ['Write', 'Edit'].includes(event.content?.name) ||
            event.actions?.workspaceFact?.kind === 'maka.workspace.version_accepted',
        );
    } finally {
      db.close();
    }
  };
  let mutationsBefore = readMutations();
  assert.equal(
    mutationsBefore.filter((event) => event.content?.kind === 'function_response').length,
    candidateInterrupt ? 0 : failedResultInterrupt ? 1 : 2,
  );
  if (failedResultInterrupt) {
    const response = mutationsBefore.find((event) => event.content?.kind === 'function_response');
    assert.equal(response.content.name, 'Edit');
    assert.equal(response.content.isError, true);
    assert.equal(
      response.actions?.managedMutationTerminal?.terminalKind,
      'operation_failed_no_effect',
    );
    assert.equal(mutationsBefore.filter((event) => event.actions?.workspaceFact).length, 0);
    candidateEvidence = {
      sessionId: response.sessionId,
      turnId: response.turnId,
      operationId: response.refs.operationId,
    };
    const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
    try {
      candidateEvidence.heads = db
        .prepare('SELECT * FROM runtime_workspace_heads ORDER BY workspace_id')
        .all();
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM runtime_managed_mutation_reservations').get()
          .count,
        0,
      );
    } finally {
      db.close();
    }
    await writeFile(
      join(root, 'failed-result-before-kill.json'),
      JSON.stringify(response, null, 2),
    );
  }
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
  for (restartNumber = 1; restartNumber <= (repeatInterrupt ? 2 : 1); restartNumber++) {
    const registration = JSON.parse(
      await readFile(join(controlDirectory, 'registration.json'), 'utf8'),
    );
    assert.equal(registration.rootId, capability.rootId);
    assert.equal(registration.state, 'ready');
    assert.ok(Number.isSafeInteger(registration.pid) && registration.pid > 0);
    // Desktop may launch through a utility process. Verify the actual Host command,
    // not an assumed direct-parent topology, against this newly created root.
    const command =
      process.platform === 'win32'
        ? (
            await promisify(execFile)(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${registration.pid}').CommandLine`,
              ],
              { timeout: 10000, windowsHide: true },
            )
          ).stdout.trim()
        : (
            await promisify(execFile)('ps', ['-o', 'args=', '-p', String(registration.pid)], {
              timeout: 10000,
            })
          ).stdout.trim();
    assert.ok(command.includes(capability.rootId), 'Host must name the isolated root ID');
    assert.ok(command.includes(workspace), 'Host must name the isolated workspace path');
    assert.ok(command.includes('--expected-root-id'), 'Host must use verified-root startup');
    if (candidateDebugger) assert.equal(candidateDebugger.pid, registration.pid);
    process.kill(registration.pid, 'SIGKILL');
    if (candidateDebugger) {
      // Observe real process death before detaching the debugger.
      await expect
        .poll(
          () => {
            try {
              process.kill(registration.pid, 0);
              return false;
            } catch (error) {
              if (error.code === 'ESRCH') return true;
              throw error;
            }
          },
          { timeout: 10000 },
        )
        .toBe(true);
      candidateDebugger.close();
      candidateDebugger = undefined;
      delete env.MAKA_MANAGED_SMOKE_DEBUG_HOST;
      assert.deepEqual(readMutations(), mutationsBefore, 'Killed Host must not have committed T2');
    }
    await closeElectronApplication(app, 5000);
    app = undefined;
    restarted = true;
    operationStep = 0;
    waitingForCompletion = false;
    app = await electron.launch({
      args: [join(repo, 'scripts/desktop-managed-smoke-entry.cjs')],
      cwd: join(repo, 'apps/desktop'),
      env,
      timeout: 30000,
    });
    app.process().stderr?.on('data', (chunk) => logs.push(chunk.toString()));
    await expect
      .poll(
        () => {
          page = app
            .windows()
            .find(
              (candidate) =>
                candidate.url().includes('/index.html') && !candidate.url().includes('surface='),
            );
          return Boolean(page);
        },
        { timeout: 30000 },
      )
      .toBe(true);
    await page
      .getByText('Managed files smoke task', { exact: true })
      .first()
      .click({ timeout: 30000 });
    if (failedBeforeTerminal) {
      // An in-memory error is not durable evidence. Startup must not synthesize it.
      assert.deepEqual(readMutations(), mutationsBefore);
      await page
        .getByRole('button', { name: 'Continue this turn', exact: true })
        .click({ timeout: 30000 });
      await expect(
        page
          .getByRole('log')
          .getByText('This task does not currently meet the conditions to continue.', {
            exact: false,
          }),
      ).toBeVisible({ timeout: 15000 });
      const reopened = JSON.parse(
        await readFile(join(controlDirectory, 'registration.json'), 'utf8'),
      );
      assert.equal(reopened.rootId, capability.rootId);
      assert.notEqual(reopened.hostEpoch, registration.hostEpoch);
      await assert.rejects(
        readFile(
          join(
            workspace,
            `managed-files-${createHash('sha256').update(candidateEvidence.sessionId).digest('hex')}.git`,
            'refs',
            'maka',
            'candidates',
            createHash('sha256').update(candidateEvidence.operationId).digest('hex'),
          ),
        ),
        { code: 'ENOENT' },
      );
      const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
      try {
        const events = db
          .prepare('SELECT payload_json FROM runtime_events ORDER BY rowid')
          .all()
          .map(({ payload_json }) => JSON.parse(payload_json));
        assert.equal(
          events.filter((event) => event.content?.kind === 'invocation_opened').length,
          1,
        );
        assert.equal(
          db
            .prepare(
              'SELECT COUNT(*) AS count FROM runtime_managed_mutation_reservations WHERE operation_id = ?',
            )
            .get(candidateEvidence.operationId).count,
          1,
        );
        assert.deepEqual(
          db.prepare('SELECT * FROM runtime_workspace_heads ORDER BY workspace_id').all(),
          candidateEvidence.heads,
        );
        assert.deepEqual(readMutations(), mutationsBefore);
        assert.equal(requests.filter(({ body }) => body.stream).length, 1);
        assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'baseline\n');
        await writeFile(
          join(root, 'failed-before-terminal-parked.json'),
          JSON.stringify({ events, candidateEvidence }, null, 2),
        );
      } finally {
        db.close();
      }
      await page.screenshot({ path: join(root, 'parked.png') });
      break;
    }
    if (interruptTurn) {
      if (candidateInterrupt) {
        await expect
          .poll(
            () =>
              readMutations().filter((event) => event.content?.kind === 'function_response').length,
            { timeout: 30000 },
          )
          .toBe(1);
        const recovered = readMutations();
        assert.deepEqual(
          recovered.filter((event) => mutationsBefore.some((before) => before.id === event.id)),
          mutationsBefore,
        );
        const response = recovered.find((event) => event.content?.kind === 'function_response');
        assert.equal(response.id, `${candidateEvidence.operationId}_recovered_response`);
        assert.equal(response.content.name, candidateToolName);
        const successors = recovered.filter(
          (event) => event.actions?.workspaceFact?.kind === 'maka.workspace.version_accepted',
        );
        assert.equal(successors.length, candidateNoopInterrupt ? 0 : 1);
        if (candidateNoopInterrupt) {
          assert.equal(Boolean(response.content.isError), false);
          assert.equal(
            response.actions?.managedMutationTerminal?.terminalKind,
            'no_workspace_change',
          );
          const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
          try {
            assert.deepEqual(
              db.prepare('SELECT * FROM runtime_workspace_heads ORDER BY workspace_id').all(),
              candidateEvidence.heads,
            );
            assert.equal(
              db
                .prepare(
                  'SELECT COUNT(*) AS count FROM runtime_managed_mutation_reservations WHERE operation_id = ?',
                )
                .get(candidateEvidence.operationId).count,
              0,
            );
          } finally {
            db.close();
          }
          await writeFile(
            join(root, 'no-change-recovered.json'),
            JSON.stringify(response, null, 2),
          );
        } else {
          assert.equal(
            successors[0].actions.workspaceFact.payload.commitOid,
            candidateEvidence.candidateCommitOid,
          );
        }
        mutationsBefore = recovered;
      }
      await page
        .getByRole('button', { name: 'Continue this turn', exact: true })
        .click({ timeout: 30000 });
    } else {
      await expect(page.getByText('MANAGED_DESKTOP_SMOKE_OK', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await page
        .locator('.maka-composer-editor [contenteditable="true"]')
        .fill('Read tracked.txt after restarting. Do not write or edit.');
      await page.locator('.maka-composer button[type="submit"]').click();
    }
    {
      if (repeatInterrupt && restartNumber === 1) {
        await expect.poll(() => waitingForCompletion, { timeout: 30000 }).toBe(true);
      } else {
        await expect(page.getByText('MANAGED_DESKTOP_REOPEN_OK', { exact: true })).toBeVisible({
          timeout: 30000,
        });
      }
      const afterRequest = requests.filter(({ body }) => body.stream).at(-1);
      const afterResults = afterRequest.body.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((part) => part.type === 'tool_result');
      assert.equal(
        afterResults.length,
        (candidateInterrupt ? 1 : failedResultInterrupt ? 2 : 3) + restartNumber,
        'Reopened model history includes the three durable results and new Read',
      );
      assert.match(JSON.stringify(afterResults.at(-1)), expectedContent);
      assert.equal(Boolean(afterResults.at(-1)?.is_error), false);
      if (candidateInterrupt || failedResultInterrupt) {
        const response = mutationsBefore.find(
          (event) => event.content?.kind === 'function_response',
        );
        const projection = response.content.modelProjection;
        assert.ok(['json', 'text'].includes(projection.kind));
        assert.equal(Boolean(afterResults[0].is_error), failedResultInterrupt);
        assert.deepEqual(
          projection.kind === 'json'
            ? JSON.parse(afterResults[0].content)
            : afterResults[0].content,
          projection.kind === 'json' ? projection.value : projection.text,
          'Model replay must use the accepted recovered result',
        );
        const transcript = await page.evaluate(async ({ sessionId, turnId }) => {
          const sessions = await window.maka.sessions.list();
          const matches = sessions.filter((session) => JSON.parse(session.id)[1] === sessionId);
          if (matches.length !== 1) throw new Error('Expected one scoped Desktop recovery session');
          return window.maka.transcripts.readTurn(matches[0].id, turnId);
        }, candidateEvidence);
        const recoveredResults = transcript.filter(
          (message) => message.type === 'tool_result' && message.toolUseId === response.content.id,
        );
        assert.equal(
          recoveredResults.length,
          1,
          'Desktop transcript must show exactly one recovered result',
        );
        assert.equal(recoveredResults[0].isError, failedResultInterrupt);
        assert.deepEqual(recoveredResults[0].content, response.content.result);
        await writeFile(
          join(root, 'recovered-transcript.json'),
          JSON.stringify(transcript, null, 2),
        );
      }
    }
    assert.deepEqual(
      readMutations(),
      mutationsBefore,
      'Reopen must preserve the exact Write/Edit outcomes and successors',
    );
    if (failedResultInterrupt) {
      const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.deepEqual(
          db.prepare('SELECT * FROM runtime_workspace_heads ORDER BY workspace_id').all(),
          candidateEvidence.heads,
        );
        assert.equal(
          db.prepare('SELECT COUNT(*) AS count FROM runtime_managed_mutation_reservations').get()
            .count,
          0,
        );
      } finally {
        db.close();
      }
    }
    if (interruptTurn) {
      const db = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
      try {
        const openings = db
          .prepare('SELECT payload_json FROM runtime_events ORDER BY rowid')
          .all()
          .map(({ payload_json }) => JSON.parse(payload_json))
          .filter((event) => event.content?.kind === 'invocation_opened');
        assert.equal(openings.length, 1 + restartNumber, 'Continue creates exactly one new Run');
        assert.equal(openings[0].content.source.kind, 'fresh');
        const source = openings[restartNumber].content.source;
        assert.equal(source.kind, 'continuation', 'Resume must not degrade to a fresh message');
        assert.equal(source.sourceRunId, openings[restartNumber - 1].runId);
        assert.notEqual(openings[restartNumber].runId, openings[restartNumber - 1].runId);
        assert.ok(source.claimId);
        assert.ok(source.sourceRuntimeEventHighWater > 0);
        assert.match(source.boundaryDigest, /^sha256:[a-f0-9]{64}$/);
      } finally {
        db.close();
      }
    }
    const reopened = JSON.parse(
      await readFile(join(controlDirectory, 'registration.json'), 'utf8'),
    );
    assert.equal(reopened.rootId, capability.rootId);
    assert.notEqual(reopened.hostEpoch, registration.hostEpoch);
    assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'baseline\n');
    await page.screenshot({ path: join(root, 'reopened.png') });
    await writeFile(
      join(root, 'restart-evidence.json'),
      JSON.stringify(
        {
          oldEpoch: registration.hostEpoch,
          newEpoch: reopened.hostEpoch,
          mutationEvents: mutationsBefore.map((event) => event.id),
          checkpoint: candidateInterrupt
            ? 'candidate verified; debugger before SQLite T2; Host killed; startup settlement; explicit Continue'
            : interruptTurn
              ? 'tool results durable; model completion pending; explicit source-bound Continue'
              : 'completed turn; not an in-flight mutation crash',
        },
        null,
        2,
      ),
    );
  }
  console.log(
    `PASS: ${failedBeforeTerminal ? 'uncommitted failure stays unresolved and Continue is denied' : candidateInterrupt ? 'candidate-only interruption settles once and Continue replays its exact result' : interruptTurn ? 'interrupted turn continues with accepted Read' : 'completed turn reopens with accepted Read'} after Host kill and Desktop restart; accepted mutation events unchanged.`,
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(root, 'failure.png'), timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  try {
    candidateDebugger?.close();
    if (app) await closeElectronApplication(app, 5000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(join(root, 'logs.txt'), logs.join(''));
    await writeFile(join(root, 'model-requests.json'), JSON.stringify(requests, null, 2));
  }
}
