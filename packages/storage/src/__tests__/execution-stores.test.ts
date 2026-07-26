import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  type AgentRunEvent,
  type AgentRunHeader,
  type AttachmentRef,
  type QuoteRef,
  type RuntimeEvent,
} from '@maka/core';
import {
  createAgentRunStore,
  ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES,
  ROOT_TURN_ADMISSION_MAX_RECORD_BYTES,
  ROOT_TURN_ADMISSION_SCHEMA_VERSION,
} from '../agent-run-store.js';
import {
  authenticateExecutionStoresReader,
  authenticateExecutionStoresWriter,
  openHeadlessExecutionStoresForRead,
  openHeadlessExecutionStoresForWrite,
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '../execution-stores.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootLease,
} from '../root-authority.js';
import { createSessionStore } from '../session-store.js';

const chartAttachment: AttachmentRef = {
  kind: 'image',
  name: 'chart.png',
  mimeType: 'image/png',
  bytes: 128,
  ref: {
    kind: 'session_file',
    sessionId: 'session-files',
    relativePath: 'attachments/chart.png',
  },
};
const notesAttachment: AttachmentRef = {
  kind: 'doc',
  name: 'notes.txt',
  mimeType: 'text/plain',
  bytes: 64,
  ref: { kind: 'workspace_file', relativePath: 'notes/notes.txt' },
};

describe('execution stores', () => {
  test('binds Headless execution readers and writers to Headless leases', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'headless',
      });
      const writer = await openHeadlessExecutionStoresForWrite(
        createHeadlessRootLease(capability, 'write'),
      );
      assert.equal(writer.kind, 'headless');
      const session = await writer.sessionStore.create(sessionInput(root));
      await writer.sessionStore.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });

      const reader = await openHeadlessExecutionStoresForRead(
        createHeadlessRootLease(capability, 'read'),
      );
      assert.equal(reader.kind, 'headless');
      assert.equal((await reader.sessionStore.list()).length, 1);
      assert.equal((await reader.sessionStore.readMessages(session.id))[0]?.id, 'message-1');

      const interactive = await resolveStorageRoot({
        path: join(base, 'interactive'),
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(interactive);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          () =>
            openHeadlessExecutionStoresForWrite(
              owner.lease as unknown as StorageRootLease<'headless', 'write'>,
            ),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('freezes and authenticates execution store facades', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'headless',
      });
      const writer = await openHeadlessExecutionStoresForWrite(
        createHeadlessRootLease(capability, 'write'),
      );
      const session = await writer.sessionStore.create(sessionInput(root));
      const reader = await openHeadlessExecutionStoresForRead(
        createHeadlessRootLease(capability, 'read'),
      );
      const rawLocalStore = createSessionStore(root);

      assert.equal(Reflect.set(reader, 'sessionStore', rawLocalStore), false);
      assert.equal(
        Reflect.set(
          reader.sessionStore,
          'readHeader',
          rawLocalStore.readHeader.bind(rawLocalStore),
        ),
        false,
      );
      await reader.sessionStore.readHeader(session.id);
      assert.equal((await rawLocalStore.readHeaderSnapshot(session.id)).connectionLocked, false);

      const otherRoot = join(base, 'other-headless');
      await resolveStorageRoot({ path: otherRoot, kind: 'headless' });
      const rawOtherStore = createSessionStore(otherRoot);
      assert.equal(Reflect.set(writer, 'sessionStore', rawOtherStore), false);
      assert.equal(
        Reflect.set(writer.sessionStore, 'create', rawOtherStore.create.bind(rawOtherStore)),
        false,
      );

      const copiedReader = { ...reader, sessionStore: rawLocalStore };
      assert.throws(
        () => authenticateExecutionStoresReader(copiedReader, 'headless'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      const copiedWriter = { ...writer, sessionStore: rawOtherStore };
      assert.throws(
        () => authenticateExecutionStoresWriter(copiedWriter, 'headless'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    });
  });

  test('round-trips canonical root admission content and retains immutable identity', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        assert.equal(stores.kind, 'interactive');
        const session = await stores.sessionStore.create(sessionInput(root));
        const mutableAttachment = {
          ...chartAttachment,
          ref: { ...chartAttachment.ref },
        };
        const first = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [mutableAttachment, notesAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [mutableAttachment, notesAttachment],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 10,
        });
        assert.equal(first.kind, 'admitted');
        mutableAttachment.name = 'mutated.png';
        assert.equal(first.admission.normalizedInput.attachments?.[0]?.name, 'chart.png');
        assert.equal(Object.isFrozen(first.admission), true);
        assert.equal(Object.isFrozen(first.admission.normalizedInput.attachments?.[0]?.ref), true);
        assert.deepEqual(await stores.agentRunStore.listSessionRuns(session.id), []);

        const retry = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [chartAttachment, notesAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [chartAttachment, notesAttachment],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 20,
        });
        assert.equal(retry.kind, 'existing');
        assert.equal(retry.admission.runId, 'run-1');
        assert.equal(retry.admission.userMessageId, 'message-1');
        assert.equal(retry.admission.admittedAt, 10);
        assert.deepEqual(retry.admission.normalizedInput.attachments, [
          chartAttachment,
          notesAttachment,
        ]);

        const stored = await stores.agentRunStore.readRootTurnAdmission(session.id, 'turn-1');
        assert.deepEqual(stored, first.admission);
        assert.equal(Object.isFrozen(stored?.sourceMessages[0]?.content), true);

        const receipt = await stores.agentRunStore.readRootTurnSourceMessageReceipt(
          session.id,
          'source-1',
        );
        assert.equal(receipt?.admission.turnId, 'turn-1');
        assert.deepEqual(receipt?.sourceMessage, first.admission.sourceMessages[0]);
        assert.equal(Object.isFrozen(receipt), true);
        const rootProofPath = join(
          root,
          'sessions',
          session.id,
          'message-proofs',
          'root',
          'source-1.json',
        );
        await rm(rootProofPath);
        assert.equal(
          await stores.agentRunStore.readRootTurnSourceMessageReceipt(session.id, 'source-1'),
          undefined,
        );
        await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
        assert.equal(
          (await stores.agentRunStore.readRootTurnSourceMessageReceipt(session.id, 'source-1'))
            ?.admission.turnId,
          'turn-1',
        );
        const unrelatedAdmissionEntry = join(
          root,
          'sessions',
          session.id,
          'turn-admissions',
          'not-an-admission',
        );
        await writeFile(unrelatedAdmissionEntry, 'unrelated');
        assert.equal(
          (await stores.agentRunStore.readRootTurnSourceMessageReceipt(session.id, 'source-1'))
            ?.admission.turnId,
          'turn-1',
        );
        await rm(unrelatedAdmissionEntry);

        const conflict = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [notesAttachment, chartAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [notesAttachment, chartAttachment],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 30,
        });
        assert.equal(conflict.kind, 'conflict');
        assert.equal(conflict.admission.runId, 'run-1');

        const dispositionConflict = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          execution: { kind: 'linked_child_initial', agentId: 'agent', agentName: 'Agent' },
          previousRootTurnId: null,
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [chartAttachment, notesAttachment],
          },
          sourceMessages: [],
          admittedAt: 35,
        });
        assert.equal(dispositionConflict.kind, 'conflict');

        const lineageConflict = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          execution: { kind: 'external_message' },
          previousRootTurnId: 'different-predecessor',
          normalizedInput: {
            text: '<model>hello</model>',
            displayText: 'hello',
            attachments: [chartAttachment, notesAttachment],
          },
          sourceMessages: [
            {
              messageId: 'source-1',
              content: {
                text: '<model>hello</model>',
                displayText: 'hello',
                attachments: [chartAttachment, notesAttachment],
              },
              placement: 'current_turn',
              disposition: 'steering',
            },
          ],
          admittedAt: 40,
        });
        assert.equal(lineageConflict.kind, 'conflict');
        assert.equal(lineageConflict.admission.previousRootTurnId, null);

        const header = runHeader(session.id, first.admission.runId);
        await stores.agentRunStore.createRun(header);
        const bytes = await readFile(
          join(root, 'sessions', session.id, 'runs', first.admission.runId, 'run.json'),
          'utf8',
        );
        await assert.rejects(
          () => stores.agentRunStore.createRun({ ...header, updatedAt: 99 }),
          /Agent run already exists/,
        );
        assert.equal(
          await readFile(
            join(root, 'sessions', session.id, 'runs', first.admission.runId, 'run.json'),
            'utf8',
          ),
          bytes,
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('durably preserves ordered quote provenance across admission and recovery', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const expectedFirstQuote = {
        text: 'first excerpt',
        label: 'Assistant answer',
        sourceTurnId: 'origin-turn-1',
      };
      const expectedSecondQuote = {
        text: 'second excerpt',
        label: 'Tool result',
        sourceTurnId: 'origin-turn-2',
      };
      const mutableFirstQuote = { ...expectedFirstQuote };
      const mutableSecondQuote = { ...expectedSecondQuote };
      const mutableNormalizedQuotes = [mutableFirstQuote, mutableSecondQuote];
      const mutableFirstSourceQuotes = [mutableFirstQuote];
      const mutableSecondSourceQuotes = [mutableSecondQuote];
      const sourceMessages = (firstQuotes: QuoteRef[], secondQuotes: QuoteRef[]) => [
        {
          messageId: 'source-first',
          content: {
            text: 'first',
            displayText: 'First visible',
            quotes: firstQuotes,
          },
          placement: 'current_turn' as const,
          disposition: 'steering' as const,
        },
        {
          messageId: 'source-second',
          content: {
            text: 'second',
            quotes: secondQuotes,
          },
          placement: 'next_turn' as const,
          disposition: 'followup' as const,
        },
      ];

      const admitted = await store.admitRootTurn({
        sessionId: 'session-quotes',
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: {
          text: 'first\n\nsecond',
          displayText: 'First visible\n\nsecond',
          quotes: mutableNormalizedQuotes,
        },
        sourceMessages: sourceMessages(mutableFirstSourceQuotes, mutableSecondSourceQuotes),
        admittedAt: 10,
      });
      assert.equal(admitted.kind, 'admitted');

      mutableFirstQuote.text = 'caller-mutated';
      mutableSecondQuote.sourceTurnId = 'caller-mutated';
      mutableNormalizedQuotes.reverse();
      mutableFirstSourceQuotes.push({
        text: 'late excerpt',
        label: 'Late',
        sourceTurnId: 'origin-turn-late',
      });
      mutableSecondSourceQuotes.length = 0;

      assert.deepEqual(admitted.admission.normalizedInput.quotes, [
        expectedFirstQuote,
        expectedSecondQuote,
      ]);
      assert.deepEqual(admitted.admission.sourceMessages[0]?.content.quotes, [expectedFirstQuote]);
      assert.deepEqual(admitted.admission.sourceMessages[1]?.content.quotes, [expectedSecondQuote]);
      assert.equal(Object.isFrozen(admitted.admission.normalizedInput.quotes), true);
      assert.equal(Object.isFrozen(admitted.admission.normalizedInput.quotes?.[0]), true);
      assert.equal(
        Object.isFrozen(admitted.admission.sourceMessages[0]?.content.quotes?.[0]),
        true,
      );

      const stored = await createAgentRunStore(root).readRootTurnAdmission(
        'session-quotes',
        'turn-1',
      );
      assert.deepEqual(stored, admitted.admission);
      assert.notEqual(stored?.normalizedInput.quotes, admitted.admission.normalizedInput.quotes);
      assert.notEqual(
        stored?.normalizedInput.quotes?.[0],
        admitted.admission.normalizedInput.quotes?.[0],
      );

      await assert.rejects(
        () =>
          store.admitRootTurn({
            sessionId: 'session-reversed-quotes',
            turnId: 'turn-1',
            proposedRunId: 'run-1',
            proposedUserMessageId: 'message-1',
            execution: { kind: 'external_message' },
            previousRootTurnId: null,
            normalizedInput: {
              text: 'first\n\nsecond',
              displayText: 'First visible\n\nsecond',
              quotes: [expectedSecondQuote, expectedFirstQuote],
            },
            sourceMessages: sourceMessages([expectedFirstQuote], [expectedSecondQuote]),
            admittedAt: 10,
          }),
        /input content does not match source messages/,
      );

      const changedFirstQuote = {
        ...expectedFirstQuote,
        sourceTurnId: 'origin-turn-changed',
      };
      const provenanceConflict = await store.admitRootTurn({
        sessionId: 'session-quotes',
        turnId: 'turn-1',
        proposedRunId: 'run-never-used',
        proposedUserMessageId: 'message-never-used',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: {
          text: 'first\n\nsecond',
          displayText: 'First visible\n\nsecond',
          quotes: [changedFirstQuote, expectedSecondQuote],
        },
        sourceMessages: sourceMessages([changedFirstQuote], [expectedSecondQuote]),
        admittedAt: 20,
      });
      assert.equal(provenanceConflict.kind, 'conflict');

      const proofPath = join(
        root,
        'sessions',
        'session-quotes',
        'message-proofs',
        'root',
        'source-first.json',
      );
      await rm(proofPath);
      const restarted = createAgentRunStore(root);
      const recovered = await restarted.listRootTurnAdmissionsForRecovery('session-quotes');
      assert.deepEqual(recovered, [admitted.admission]);
      const receipt = await restarted.readRootTurnSourceMessageReceipt(
        'session-quotes',
        'source-first',
      );
      assert.deepEqual(receipt?.sourceMessage.content.quotes, [expectedFirstQuote]);
      assert.deepEqual(receipt?.admission.normalizedInput.quotes, [
        expectedFirstQuote,
        expectedSecondQuote,
      ]);
      assert.equal(Object.isFrozen(receipt?.sourceMessage.content.quotes?.[0]), true);
    });
  });

  test('rejects invalid root admission contracts before write and when reading disk', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const turnStartedSource = {
        messageId: 'source-message',
        content: { text: 'source' },
        placement: 'current_turn' as const,
        disposition: 'turn_started' as const,
      };
      const invalidContracts = [
        {
          name: 'external-null-message',
          userMessageId: null,
          execution: { kind: 'external_message' as const },
          sourceMessages: [],
        },
        {
          name: 'retry-with-message',
          userMessageId: 'message-1',
          execution: {
            kind: 'linked_child_provider_retry' as const,
            agentId: 'agent',
            agentName: 'Agent',
            sourceRunId: 'source-run',
          },
          sourceMessages: [],
        },
        {
          name: 'child-with-source',
          userMessageId: 'message-1',
          execution: {
            kind: 'linked_child_initial' as const,
            agentId: 'agent',
            agentName: 'Agent',
          },
          sourceMessages: [turnStartedSource],
        },
        {
          name: 'resume-self-source',
          userMessageId: 'message-1',
          execution: {
            kind: 'linked_child_resume' as const,
            agentId: 'agent',
            agentName: 'Agent',
            sourceRunId: 'run-1',
          },
          sourceMessages: [],
        },
        {
          name: 'retry-self-source',
          userMessageId: null,
          execution: {
            kind: 'linked_child_provider_retry' as const,
            agentId: 'agent',
            agentName: 'Agent',
            sourceRunId: 'run-1',
          },
          sourceMessages: [],
        },
        {
          name: 'turn-started-owner-mismatch',
          userMessageId: 'message-1',
          execution: { kind: 'external_message' as const },
          sourceMessages: [turnStartedSource],
        },
      ];

      for (const invalid of invalidContracts) {
        const sessionId = `session-${invalid.name}`;
        const turnId = 'turn-1';
        const normalizedInput =
          invalid.sourceMessages.length > 0 ? { text: 'source' } : { text: 'input' };
        await assert.rejects(
          () =>
            store.admitRootTurn({
              sessionId,
              turnId,
              proposedRunId: 'run-1',
              proposedUserMessageId: invalid.userMessageId,
              execution: invalid.execution,
              previousRootTurnId: null,
              normalizedInput,
              sourceMessages: invalid.sourceMessages,
              admittedAt: 10,
            }),
          /Invalid root turn admission contract/,
        );
        assert.equal(await store.readRootTurnAdmission(sessionId, turnId), undefined);

        const admissionRoot = join(root, 'sessions', sessionId, 'turn-admissions');
        await mkdir(admissionRoot, { recursive: true });
        await writeFile(
          join(admissionRoot, `${turnId}.json`),
          `${JSON.stringify({
            schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
            sessionId,
            turnId,
            runId: 'run-1',
            userMessageId: invalid.userMessageId,
            execution: invalid.execution,
            previousRootTurnId: null,
            normalizedInput,
            sourceMessages: invalid.sourceMessages,
            admittedAt: 10,
          })}\n`,
        );
        await assert.rejects(
          () => store.readRootTurnAdmission(sessionId, turnId),
          /Invalid root turn admission contract/,
        );
      }
    });
  });

  test('treats ordered source messages as identity and fails closed on ambiguous receipts', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const sources = [
        {
          messageId: 'source-steering',
          content: { text: 'steering' },
          placement: 'current_turn' as const,
          disposition: 'steering' as const,
        },
        {
          messageId: 'source-followup',
          content: { text: 'followup' },
          placement: 'next_turn' as const,
          disposition: 'followup' as const,
        },
      ];
      const base = {
        sessionId: 'session-source-order',
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        admittedAt: 10,
      } as const;
      assert.equal(
        (
          await store.admitRootTurn({
            ...base,
            normalizedInput: { text: 'steering\n\nfollowup' },
            sourceMessages: sources,
          })
        ).kind,
        'admitted',
      );

      const reordered = await store.admitRootTurn({
        ...base,
        proposedRunId: 'unused-run',
        proposedUserMessageId: 'unused-message',
        normalizedInput: { text: 'followup\n\nsteering' },
        sourceMessages: [...sources].reverse(),
      });
      assert.equal(reordered.kind, 'conflict');

      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            proposedRunId: 'unused-run',
            proposedUserMessageId: 'unused-message',
            normalizedInput: { text: 'steering\n\nfollowup' },
            sourceMessages: [{ ...sources[0]! }, { ...sources[1]!, placement: 'current_turn' }],
          }),
        /Invalid root turn source message/,
      );

      const invalidAdmissionRoot = join(
        root,
        'sessions',
        'session-invalid-followup',
        'turn-admissions',
      );
      await mkdir(invalidAdmissionRoot, { recursive: true });
      await writeFile(
        join(invalidAdmissionRoot, 'turn-1.json'),
        `${JSON.stringify({
          schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
          sessionId: 'session-invalid-followup',
          turnId: 'turn-1',
          runId: 'run-1',
          userMessageId: 'message-1',
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: { text: 'followup' },
          sourceMessages: [
            {
              messageId: 'source-followup',
              content: { text: 'followup' },
              placement: 'current_turn',
              disposition: 'followup',
            },
          ],
          admittedAt: 10,
        })}\n`,
      );
      await assert.rejects(
        () => store.readRootTurnAdmission('session-invalid-followup', 'turn-1'),
        /Invalid root turn source message/,
      );

      const startedFromNextPlacement = await store.admitRootTurn({
        sessionId: 'session-turn-started-next',
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: { text: 'started' },
        sourceMessages: [
          {
            messageId: 'message-1',
            content: { text: 'started' },
            placement: 'next_turn',
            disposition: 'turn_started',
          },
        ],
        admittedAt: 10,
      });
      assert.equal(startedFromNextPlacement.kind, 'admitted');

      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...base,
            turnId: 'turn-2',
            proposedRunId: 'run-2',
            proposedUserMessageId: 'message-2',
            execution: { kind: 'external_message' },
            previousRootTurnId: 'turn-1',
            normalizedInput: { text: 'followup' },
            sourceMessages: [{ ...sources[1]! }],
          }),
        /Root source message identity belongs to both turn-1 and turn-2/,
      );
    });
  });

  test('rejects a competing source owner without publishing its Turn or partial proofs', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const admit = (suffix: 'a' | 'b') =>
        store.admitRootTurn({
          sessionId: 'session-proof-conflict',
          turnId: `turn-${suffix}`,
          proposedRunId: `run-${suffix}`,
          proposedUserMessageId: `message-${suffix}`,
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: { text: `unique-${suffix}\n\nshared` },
          sourceMessages: [
            {
              messageId: `source-${suffix}`,
              content: { text: `unique-${suffix}` },
              placement: 'current_turn',
              disposition: 'steering',
            },
            {
              messageId: 'source-shared',
              content: { text: 'shared' },
              placement: 'next_turn',
              disposition: 'followup',
            },
          ],
          admittedAt: suffix === 'a' ? 10 : 20,
        });

      const settled = await Promise.allSettled([admit('a'), admit('b')]);
      const admittedIndex = settled.findIndex(
        (result) => result.status === 'fulfilled' && result.value.kind === 'admitted',
      );
      const rejectedIndex = settled.findIndex((result) => result.status === 'rejected');
      assert.notEqual(admittedIndex, -1);
      assert.notEqual(rejectedIndex, -1);
      assert.match(
        String(
          rejectedIndex === -1
            ? undefined
            : (settled[rejectedIndex] as PromiseRejectedResult).reason,
        ),
        /Root source message identity belongs to both/,
      );

      const winner = admittedIndex === 0 ? 'a' : 'b';
      const loser = winner === 'a' ? 'b' : 'a';
      assert.equal(
        await store.readRootTurnAdmission('session-proof-conflict', `turn-${loser}`),
        undefined,
      );
      assert.equal(
        await store.readRootTurnSourceMessageReceipt('session-proof-conflict', `source-${loser}`),
        undefined,
      );
      assert.equal(
        (await store.readRootTurnSourceMessageReceipt('session-proof-conflict', 'source-shared'))
          ?.admission.turnId,
        `turn-${winner}`,
      );

      await rm(
        join(
          root,
          'sessions',
          'session-proof-conflict',
          'message-proofs',
          'root',
          `source-${winner}.json`,
        ),
      );
      const restartedStore = createAgentRunStore(root);
      const recovered =
        await restartedStore.listRootTurnAdmissionsForRecovery('session-proof-conflict');
      assert.deepEqual(
        recovered.map((admission) => admission.turnId),
        [`turn-${winner}`],
      );
      assert.equal(
        (
          await restartedStore.readRootTurnSourceMessageReceipt(
            'session-proof-conflict',
            `source-${winner}`,
          )
        )?.admission.turnId,
        `turn-${winner}`,
      );
      assert.equal(
        await restartedStore.readRootTurnSourceMessageReceipt(
          'session-proof-conflict',
          `source-${loser}`,
        ),
        undefined,
      );
    });
  });

  test('shares root admission serialization across writer facades from one live lease', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;

      let winner: 'a' | 'b' | undefined;
      let loser: 'a' | 'b' | undefined;
      try {
        const [first, second] = await Promise.all([
          openInteractiveExecutionStoresForWrite(owner.lease),
          openInteractiveExecutionStoresForWrite(owner.lease),
        ]);
        const session = await first.sessionStore.create(sessionInput(root));
        const input = (suffix: 'a' | 'b') => ({
          sessionId: session.id,
          turnId: `turn-${suffix}`,
          proposedRunId: `run-${suffix}`,
          proposedUserMessageId: `message-${suffix}`,
          execution: { kind: 'external_message' as const },
          previousRootTurnId: null,
          normalizedInput: { text: `unique-${suffix}\n\nshared` },
          sourceMessages: [
            {
              messageId: `source-${suffix}`,
              content: { text: `unique-${suffix}` },
              placement: 'current_turn' as const,
              disposition: 'steering' as const,
            },
            {
              messageId: 'source-shared',
              content: { text: 'shared' },
              placement: 'next_turn' as const,
              disposition: 'followup' as const,
            },
          ],
          admittedAt: suffix === 'a' ? 10 : 20,
        });

        const settled = await Promise.allSettled([
          first.agentRunStore.admitRootTurn(input('a')),
          second.agentRunStore.admitRootTurn(input('b')),
        ]);
        const admittedIndex = settled.findIndex(
          (result) => result.status === 'fulfilled' && result.value.kind === 'admitted',
        );
        const rejectedIndex = settled.findIndex((result) => result.status === 'rejected');
        assert.notEqual(admittedIndex, -1);
        assert.notEqual(rejectedIndex, -1);
        assert.match(
          String(
            rejectedIndex === -1
              ? undefined
              : (settled[rejectedIndex] as PromiseRejectedResult).reason,
          ),
          /Root source message identity belongs to both/,
        );

        winner = admittedIndex === 0 ? 'a' : 'b';
        loser = winner === 'a' ? 'b' : 'a';
        assert.equal(
          await first.agentRunStore.readRootTurnAdmission(session.id, `turn-${loser}`),
          undefined,
        );
        assert.equal(
          await first.agentRunStore.readRootTurnSourceMessageReceipt(session.id, `source-${loser}`),
          undefined,
        );
        assert.equal(first, second);

        await rm(
          join(root, 'sessions', session.id, 'message-proofs', 'root', `source-${winner}.json`),
        );
      } finally {
        await owner.close();
      }

      assert.ok(winner);
      assert.ok(loser);
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      if (!successor) return;
      try {
        const reopened = await openInteractiveExecutionStoresForWrite(successor.lease);
        const sessions = await reopened.sessionStore.list();
        assert.equal(sessions.length, 1);
        const sessionId = sessions[0]!.id;
        const recovered = await reopened.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId);
        assert.deepEqual(
          recovered.map((admission) => admission.turnId),
          [`turn-${winner}`],
        );
        assert.equal(
          (
            await reopened.agentRunStore.readRootTurnSourceMessageReceipt(
              sessionId,
              `source-${winner}`,
            )
          )?.admission.turnId,
          `turn-${winner}`,
        );
        assert.equal(
          await reopened.agentRunStore.readRootTurnSourceMessageReceipt(
            sessionId,
            `source-${loser}`,
          ),
          undefined,
        );
      } finally {
        await successor.close();
      }
    });
  });

  test('round-trips only the final root admission schema v1', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const admitted = await store.admitRootTurn({
        sessionId: 'session-schema',
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: { text: 'hello' },
        sourceMessages: [],
        admittedAt: 10,
      });
      assert.equal(admitted.kind, 'admitted');

      const path = join(root, 'sessions', 'session-schema', 'turn-admissions', 'turn-1.json');
      const v1 = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.equal(v1.schemaVersion, 1);
      assert.deepEqual(
        await createAgentRunStore(root).readRootTurnAdmission('session-schema', 'turn-1'),
        admitted.admission,
      );

      await writeFile(path, `${JSON.stringify({ ...v1, schemaVersion: 2 })}\n`, 'utf8');
      const reopened = createAgentRunStore(root);
      await assert.rejects(
        () => reopened.readRootTurnAdmission('session-schema', 'turn-1'),
        /Invalid root turn admission/,
      );
      await assert.rejects(
        () => reopened.listRootTurnAdmissionsForRecovery('session-schema'),
        /Invalid root turn admission/,
      );
    });
  });

  test('keys operation receipts by Host Epoch and discards completed Epochs', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const receipt = {
          payload: {
            originHostEpoch: 'epoch-1',
            sessionId: 'session-1',
            retractId: 'retract-1',
          },
          result: { queueRevision: 3, retracted: [] },
        };
        await stores.messageReceiptStore.beginHostEpoch('epoch-1');
        await stores.messageReceiptStore.commit(
          'epoch-1',
          'retract',
          'session-1',
          'retract-1',
          receipt,
        );
        assert.deepEqual(
          await stores.messageReceiptStore.read('epoch-1', 'retract', 'session-1', 'retract-1'),
          receipt,
        );
        await assert.rejects(
          () =>
            stores.messageReceiptStore.commit('epoch-1', 'retract', 'session-1', 'retract-1', {
              ...receipt,
              result: { queueRevision: 4, retracted: [] },
            }),
          /identity conflict/,
        );

        await stores.messageReceiptStore.beginHostEpoch('epoch-2');
        assert.equal(
          await stores.messageReceiptStore.read('epoch-1', 'retract', 'session-1', 'retract-1'),
          undefined,
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('rejects malformed and oversized admission content at the Store boundary', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const admit = (label: string, attachment: AttachmentRef) =>
        store.admitRootTurn({
          sessionId: `session-${label}`,
          turnId: 'turn-1',
          proposedRunId: `run-${label}`,
          proposedUserMessageId: `message-${label}`,
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: { text: 'content', attachments: [attachment] },
          sourceMessages: [],
          admittedAt: 10,
        });

      await assert.rejects(
        () =>
          admit('unsafe-path', {
            ...notesAttachment,
            ref: { kind: 'workspace_file', relativePath: '../secret' },
          }),
        /Invalid root turn normalized input attachment/,
      );
      await assert.rejects(
        () =>
          admit('unsafe-session', {
            ...chartAttachment,
            ref: {
              kind: 'session_file',
              sessionId: 'not/safe',
              relativePath: 'attachments/chart.png',
            },
          }),
        /Invalid root turn normalized input attachment/,
      );
      await assert.rejects(
        () =>
          admit('oversized-attachment', { ...chartAttachment, bytes: MAX_ATTACHMENT_BYTES + 1 }),
        /Invalid root turn normalized input attachment/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            sessionId: 'session-too-many',
            turnId: 'turn-1',
            proposedRunId: 'run-too-many',
            proposedUserMessageId: 'message-too-many',
            execution: { kind: 'external_message' },
            previousRootTurnId: null,
            normalizedInput: {
              text: 'content',
              attachments: Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => notesAttachment),
            },
            sourceMessages: [],
            admittedAt: 10,
          }),
        /Invalid root turn normalized input/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            sessionId: 'session-large-content',
            turnId: 'turn-1',
            proposedRunId: 'run-large-content',
            proposedUserMessageId: 'message-large-content',
            execution: { kind: 'external_message' },
            previousRootTurnId: null,
            normalizedInput: { text: 'x'.repeat(ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES + 1) },
            sourceMessages: [],
            admittedAt: 10,
          }),
        /content exceeds size limit/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            sessionId: 'session-large-quote',
            turnId: 'turn-1',
            proposedRunId: 'run-large-quote',
            proposedUserMessageId: 'message-large-quote',
            execution: { kind: 'external_message' },
            previousRootTurnId: null,
            normalizedInput: {
              text: 'content',
              quotes: [{ text: 'q'.repeat(ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES) }],
            },
            sourceMessages: [],
            admittedAt: 10,
          }),
        /content exceeds size limit/,
      );

      const oversizedAdmissionRoot = join(
        root,
        'sessions',
        'session-large-record',
        'turn-admissions',
      );
      await mkdir(oversizedAdmissionRoot, { recursive: true });
      await writeFile(
        join(oversizedAdmissionRoot, 'turn-1.json'),
        JSON.stringify({ padding: 'x'.repeat(ROOT_TURN_ADMISSION_MAX_RECORD_BYTES) }),
      );
      await assert.rejects(
        () => store.readRootTurnAdmission('session-large-record', 'turn-1'),
        /record exceeds size limit/,
      );

      await assert.rejects(
        () =>
          store.admitRootTurn({
            sessionId: 'session-invalid-source',
            turnId: 'turn-1',
            proposedRunId: 'run-invalid-source',
            proposedUserMessageId: 'message-invalid-source',
            execution: { kind: 'external_message' },
            previousRootTurnId: null,
            normalizedInput: { text: 'content' },
            sourceMessages: [
              {
                messageId: 'invalid/source',
                content: { text: 'content' },
                placement: 'current_turn',
                disposition: 'turn_started',
              },
            ],
            admittedAt: 10,
          }),
        /Invalid root turn source message/,
      );
    });
  });

  test('keeps shared execution reads observational', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const rawSessionStore = createSessionStore(root);
      const session = await rawSessionStore.create(sessionInput(root));
      await rawSessionStore.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });
      const rawAgentRunStore = createAgentRunStore(root);
      await rawAgentRunStore.admitRootTurn({
        sessionId: session.id,
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: { text: 'hello' },
        sourceMessages: [],
        admittedAt: 9,
      });
      await rawAgentRunStore.createRun(runHeader(session.id, 'run-1'));
      const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
      const before = await readFile(sessionPath, 'utf8');

      const reader = await tryAcquireInteractiveRootReader(capability);
      assert.ok(reader);
      if (!reader) return;
      try {
        const stores = await openInteractiveExecutionStoresForRead(reader.lease);
        assert.equal((await stores.sessionStore.list()).length, 1);
        assert.equal((await stores.sessionStore.readHeader(session.id)).connectionLocked, false);
        assert.equal((await stores.sessionStore.readMessages(session.id)).length, 1);
        assert.equal((await stores.sessionStore.listTurns(session.id)).length, 1);
        assert.equal((await stores.agentRunStore.listSessionRuns(session.id)).length, 1);
        assert.equal((await stores.agentRunStore.readRun(session.id, 'run-1')).turnId, 'turn-1');
        assert.equal((await stores.agentRunStore.readEvents(session.id, 'run-1')).length, 0);
        assert.equal(
          (await stores.agentRunStore.readRootTurnAdmission(session.id, 'turn-1'))?.runId,
          'run-1',
        );
        assert.equal(
          (await stores.runtimeEventStore.readRuntimeEvents(session.id, 'run-1')).length,
          0,
        );
        assert.equal(
          (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, 'run-1')).length,
          0,
        );
        assert.equal(
          (await stores.runtimeEventStore.readSessionRuntimeEvents(session.id)).length,
          0,
        );
      } finally {
        await reader.close();
      }

      assert.equal(await readFile(sessionPath, 'utf8'), before);
      assert.equal((await rawSessionStore.readHeaderSnapshot(session.id)).connectionLocked, false);
    });
  });

  test('repairs only an unterminated JSONL tail before the next durable append', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const header = runHeader(session.id, 'run-1');
        await stores.agentRunStore.createRun(header);

        const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
        await appendFile(sessionPath, '{"type":"user"', 'utf8');
        await stores.sessionStore.appendMessage(session.id, {
          type: 'user',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 11,
          text: 'hello',
        });
        assert.deepEqual(
          (await stores.sessionStore.readMessages(session.id)).map((message) => message.id),
          ['message-1'],
        );

        const eventsPath = join(root, 'sessions', session.id, 'runs', header.runId, 'events.jsonl');
        await writeFile(
          eventsPath,
          JSON.stringify(runEvent(session.id, header.runId, 'event-1', 12)),
          'utf8',
        );
        await stores.agentRunStore.appendEvent(
          session.id,
          header.runId,
          runEvent(session.id, header.runId, 'event-2', 13),
        );
        await appendFile(eventsPath, '{"type":"run_started"', 'utf8');
        await stores.agentRunStore.appendEvent(
          session.id,
          header.runId,
          runEvent(session.id, header.runId, 'event-3', 14),
        );
        assert.deepEqual(
          (await stores.agentRunStore.readEvents(session.id, header.runId)).map(
            (event) => event.id,
          ),
          ['event-1', 'event-2', 'event-3'],
        );

        const runtimeEventsPath = join(
          root,
          'sessions',
          session.id,
          'runs',
          header.runId,
          'runtime-events.jsonl',
        );
        await writeFile(runtimeEventsPath, '{"id":"truncated"', 'utf8');
        await stores.runtimeEventStore.appendRuntimeEvent(
          session.id,
          header.runId,
          runtimeEvent(session.id, header.runId, 'runtime-1', 15),
        );
        assert.deepEqual(
          (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, header.runId)).map(
            (event) => event.id,
          ),
          ['runtime-1'],
        );
        const steering = {
          ...runtimeEvent(session.id, header.runId, 'runtime-steering', 16),
          content: { kind: 'text' as const, text: 'steer', steering: true as const },
          refs: { providerEventId: 'message-steering' },
        };
        await stores.runtimeEventStore.appendRuntimeEvent(session.id, header.runId, steering);
        assert.deepEqual(
          await stores.runtimeEventStore.readImmutableSteeringMessageProof(
            session.id,
            'message-steering',
          ),
          { event: steering },
        );
        const steeringProofPath = join(
          root,
          'sessions',
          session.id,
          'message-proofs',
          'steering',
          'message-steering.json',
        );
        await rm(steeringProofPath);
        assert.equal(
          await stores.runtimeEventStore.readImmutableSteeringMessageProof(
            session.id,
            'message-steering',
          ),
          undefined,
        );
        await stores.runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(session.id);
        assert.deepEqual(
          await stores.runtimeEventStore.readImmutableSteeringMessageProof(
            session.id,
            'message-steering',
          ),
          { event: steering },
        );
        assert.equal(
          await stores.runtimeEventStore.readImmutableSteeringMessageProof(
            session.id,
            'message-unknown',
          ),
          undefined,
        );

        for (const path of [sessionPath, eventsPath, runtimeEventsPath]) {
          const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
          for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
        }
      } finally {
        await owner.close();
      }
    });
  });

  test('refuses to truncate a syntactically invalid JSONL tail', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
        await appendFile(sessionPath, '{"type":]', 'utf8');
        const before = await readFile(sessionPath, 'utf8');

        await assert.rejects(
          () =>
            stores.sessionStore.appendMessage(session.id, {
              type: 'user',
              id: 'message-1',
              turnId: 'turn-1',
              ts: 1,
              text: 'must not overwrite corruption',
            }),
          /Cannot append after an invalid JSONL tail record/,
        );
        assert.equal(await readFile(sessionPath, 'utf8'), before);
      } finally {
        await owner.close();
      }
    });
  });

  test('rejects stale writers before a replacement root is mutated', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const moved = join(base, 'moved-root');
      await rename(root, moved);
      await mkdir(root);
      try {
        await assert.rejects(
          () => stores.sessionStore.create(sessionInput(root)),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
        );
        await assert.rejects(() => stat(join(root, 'sessions')), {
          code: 'ENOENT',
        });
      } finally {
        await owner.close();
      }
    });
  });

  test('strict recovery removes recognizable uncommitted exclusive-create staging', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: { text: 'hello' },
          sourceMessages: [],
          admittedAt: 10,
        });

        const suffix = '123.00000000-0000-4000-8000-000000000000.tmp';
        const admissionsRoot = join(root, 'sessions', session.id, 'turn-admissions');
        const admissionTemp = join(admissionsRoot, `turn-1.json.${suffix}`);
        await writeFile(admissionTemp, 'staging', 'utf8');
        const runDirectory = join(root, 'sessions', session.id, 'runs', 'run-staging');
        await mkdir(runDirectory, { recursive: true });
        await writeFile(join(runDirectory, `run.json.${suffix}`), 'staging', 'utf8');

        const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
        assert.deepEqual(
          admissions.map((admission) => admission.turnId),
          ['turn-1'],
        );
        assert.deepEqual(await stores.agentRunStore.listSessionRunsForRecovery(session.id), []);
        await assert.rejects(() => stat(admissionTemp), { code: 'ENOENT' });
        await assert.rejects(() => stat(runDirectory), { code: 'ENOENT' });
      } finally {
        await owner.close();
      }
    });
  });

  test('strict recovery orders same-millisecond admissions by predecessor lineage', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      await store.admitRootTurn({
        sessionId: 'session',
        turnId: 'z-root',
        proposedRunId: 'run-root',
        proposedUserMessageId: 'message-root',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: { text: 'root' },
        sourceMessages: [],
        admittedAt: 100,
      });
      await store.admitRootTurn({
        sessionId: 'session',
        turnId: 'a-successor',
        proposedRunId: 'run-successor',
        proposedUserMessageId: 'message-successor',
        execution: { kind: 'external_message' },
        previousRootTurnId: 'z-root',
        normalizedInput: { text: 'successor' },
        sourceMessages: [],
        admittedAt: 100,
      });

      const chain = await store.listRootTurnAdmissionsForRecovery('session');
      assert.deepEqual(
        chain.map((admission) => admission.turnId),
        ['z-root', 'a-successor'],
      );
    });
  });

  test('strict recovery rejects malformed predecessor graphs', async () => {
    await withRoot(async ({ root }) => {
      const store = createAgentRunStore(root);
      const admissionsRoot = join(root, 'sessions', 'session', 'turn-admissions');
      const install = async (
        records: readonly ReturnType<typeof rootAdmissionRecord>[],
      ): Promise<void> => {
        await rm(admissionsRoot, { recursive: true, force: true });
        await mkdir(admissionsRoot, { recursive: true });
        await Promise.all(
          records.map((record) =>
            writeFile(
              join(admissionsRoot, `${record.turnId}.json`),
              `${JSON.stringify(record)}\n`,
              'utf8',
            ),
          ),
        );
      };

      await install([rootAdmissionRecord('root', null), rootAdmissionRecord('missing', 'absent')]);
      await assert.rejects(
        () => store.listRootTurnAdmissionsForRecovery('session'),
        /missing predecessor/,
      );

      await install([rootAdmissionRecord('root-a', null), rootAdmissionRecord('root-b', null)]);
      await assert.rejects(
        () => store.listRootTurnAdmissionsForRecovery('session'),
        /exactly one root/,
      );

      await install([
        rootAdmissionRecord('root', null),
        rootAdmissionRecord('left', 'root'),
        rootAdmissionRecord('right', 'root'),
      ]);
      await assert.rejects(() => store.listRootTurnAdmissionsForRecovery('session'), /branches/);

      await install([
        rootAdmissionRecord('cycle-a', 'cycle-b'),
        rootAdmissionRecord('cycle-b', 'cycle-a'),
      ]);
      await assert.rejects(
        () => store.listRootTurnAdmissionsForRecovery('session'),
        /exactly one root/,
      );
    });
  });

  test('strict recovery enumeration fails on malformed durable entities', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          execution: { kind: 'external_message' },
          previousRootTurnId: null,
          normalizedInput: { text: 'hello' },
          sourceMessages: [],
          admittedAt: 10,
        });
        await writeFile(
          join(root, 'sessions', session.id, 'turn-admissions', 'turn-1.json'),
          '{"turnId":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() =>
          stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id),
        );

        await stores.agentRunStore.createRun(runHeader(session.id, 'run-1'));
        await writeFile(
          join(root, 'sessions', session.id, 'runs', 'run-1', 'run.json'),
          '{"runId":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() => stores.agentRunStore.listSessionRunsForRecovery(session.id));

        await writeFile(
          join(root, 'sessions', session.id, 'session.jsonl'),
          '{"id":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() => stores.sessionStore.listForRecovery());
      } finally {
        await owner.close();
      }
    });
  });
});

function rootAdmissionRecord(turnId: string, previousRootTurnId: string | null) {
  return {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId: 'session',
    turnId,
    runId: `run-${turnId}`,
    userMessageId: `message-${turnId}`,
    execution: { kind: 'external_message' as const },
    previousRootTurnId,
    normalizedInput: { text: turnId },
    sourceMessages: [],
    admittedAt: 100,
  };
}

async function withRoot(
  run: (paths: { base: string; root: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-execution-stores-'));
  const root = join(base, 'root');
  try {
    await run({ base, root });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function sessionInput(root: string) {
  return {
    cwd: root,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function runHeader(sessionId: string, runId: string): AgentRunHeader {
  return {
    runId,
    invocationId: runId,
    sessionId,
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
  };
}

function runEvent(sessionId: string, runId: string, id: string, ts: number): AgentRunEvent {
  return {
    type: 'run_started',
    id,
    runId,
    sessionId,
    turnId: 'turn-1',
    ts,
  };
}

function runtimeEvent(sessionId: string, runId: string, id: string, ts: number): RuntimeEvent {
  return {
    id,
    invocationId: runId,
    runId,
    sessionId,
    turnId: 'turn-1',
    ts,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'hello' },
  };
}
