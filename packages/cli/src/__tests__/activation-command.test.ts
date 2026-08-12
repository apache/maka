import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import {
  decodeActivationRequest,
  parseMakaActivateArgs,
  runMakaActivationCli,
  type MakaActivationContext,
  type MakaActivationDeps,
  type MakaActivationRuntime,
} from '../activation-command.js';
import type { MakaRunOutcome } from '../run-command-core.js';

const ROOTS = {
  stateRoot: '/tmp/maka-state',
  workspaceRoot: '/tmp/maka-workspace',
  configRoot: '/tmp/maka-config',
};

before(async () => {
  await Promise.all(Object.values(ROOTS).map((root) => mkdir(root, { recursive: true })));
});

after(async () => {
  await Promise.all(Object.values(ROOTS).map((root) => rm(root, { recursive: true, force: true })));
});

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    activationId: 'activation-1',
    cloudSessionId: 'cloud-session-1',
    stimulus: { type: 'message', payload: { text: 'Inspect the workspace' } },
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'maka-session-1',
    cwd: ROOTS.workspaceRoot,
    name: 'activation',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'local',
    connectionLocked: true,
    model: 'fixture-model',
    permissionMode: 'explore',
    ...overrides,
  };
}

function completedResult(): MakaRunOutcome {
  return {
    outcomeId: 'run-1',
    status: 'completed',
    finalOutput: 'done sk-test-secret',
    sandboxBoundary: 'none',
  };
}

function completedEvents(): SessionEvent[] {
  return [
    {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: 'done',
    },
  ];
}

function fakeDeps(
  options: {
    input?: string;
    sessions?: SessionSummary[];
    result?: MakaRunOutcome;
    events?: SessionEvent[];
    onContext?: (input: Parameters<NonNullable<MakaActivationDeps['createContext']>>[0]) => void;
    onCreateSession?: () => void;
    onClose?: () => void;
    safeBoundaryResume?: boolean;
    onResume?: () => void;
    onSandboxBoundaryResponse?: (response: { requestId: string; decision: 'deny' }) => void;
    sendMessage?: (
      runtime: MakaActivationRuntime,
      sessionId: string,
      input: { turnId: string; text: string },
    ) => AsyncIterable<SessionEvent>;
  } = {},
): MakaActivationDeps {
  let observer: ((result: MakaRunOutcome) => void | Promise<void>) | undefined;
  const sessions = options.sessions ?? [];
  const runtime: MakaActivationRuntime = {
    async createSession() {
      options.onCreateSession?.();
      return summary();
    },
    listSessions: async () => sessions,
    ...(options.safeBoundaryResume
      ? {
          resumeLatest: async () =>
            (async function* () {
              options.onResume?.();
              for (const event of options.events ?? completedEvents()) yield event;
              await observer?.(options.result ?? completedResult());
            })(),
        }
      : {}),
    async *sendMessage(sessionId, input) {
      if (options.sendMessage) {
        yield* options.sendMessage(runtime, sessionId, input);
      } else {
        for (const event of options.events ?? completedEvents()) yield event;
      }
      await observer?.(options.result ?? completedResult());
    },
    async respondToSandboxBoundary(_sessionId, response) {
      options.onSandboxBoundaryResponse?.(response);
    },
    async stopSession() {},
  };

  return {
    createContext: async (input) => {
      options.onContext?.(input);
      observer = input.runOutcomeObserver;
      const context: MakaActivationContext = {
        runtime,
        target: {
          connection: {
            slug: 'local',
            name: 'Fixture',
            providerType: 'ollama',
            enabled: true,
            defaultModel: 'fixture-model',
          },
          apiKey: '',
          model: 'fixture-model',
        },
        close: async () => options.onClose?.(),
      };
      return context;
    },
    listSessions: async () => sessions,
    workspaceRoot: () => ROOTS.workspaceRoot,
    processCwd: () => ROOTS.workspaceRoot,
    stdinIsTTY: () => false,
    readStdin: async () => options.input ?? JSON.stringify(validRequest()),
    readFile: async () => options.input ?? JSON.stringify(validRequest()),
    writeStdout: () => {},
    writeStderr: () => {},
    onSigint: () => () => {},
    setTimer: (handler, ms) => setTimeout(handler, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    newId: () => 'turn-1',
  };
}

describe('maka activate argument and request contracts', () => {
  test('requires explicit non-overlapping roots and accepts JSON input options', () => {
    assert.deepEqual(
      parseMakaActivateArgs([
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
        '--input',
        '-',
        '--timeout',
        '2.5',
        '--max-steps',
        '4',
        '--permission-mode',
        'bypass',
      ]),
      {
        kind: 'activate',
        options: {
          ...ROOTS,
          input: '-',
          timeoutMs: 2500,
          maxSteps: 4,
          permissionMode: 'bypass',
        },
      },
    );
    assert.equal(parseMakaActivateArgs(['--state-root', ROOTS.stateRoot]).kind, 'error');
    assert.equal(
      parseMakaActivateArgs([
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
        'prompt-in-argv',
      ]).kind,
      'error',
    );
  });

  test('decodes versioned message and resumed activation requests', () => {
    assert.deepEqual(
      decodeActivationRequest(
        validRequest({
          makaSessionId: 'maka-session-1',
          stimulus: { type: 'schedule', payload: { job: 'nightly' } },
        }),
      ),
      {
        schemaVersion: 1,
        activationId: 'activation-1',
        cloudSessionId: 'cloud-session-1',
        makaSessionId: 'maka-session-1',
        stimulus: { type: 'schedule', payload: { job: 'nightly' } },
      },
    );
    assert.throws(
      () => decodeActivationRequest(validRequest({ schemaVersion: 2 })),
      /unsupported activation schema/,
    );
    assert.throws(
      () => decodeActivationRequest({ ...validRequest(), unexpected: true }),
      /unsupported activation field/,
    );
  });

  test('rejects malformed input before runtime startup', async () => {
    let started = false;
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
      ],
      {
        ...fakeDeps({ input: '{"schemaVersion":2}' }),
        createContext: async () => {
          started = true;
          throw new Error('must not start');
        },
      },
    );
    assert.equal(result, 2);
    assert.equal(started, false);
  });
});

describe('maka activate JSONL protocol', () => {
  test('emits start, redacted runtime events, and exactly one completed outcome', async () => {
    const lines: string[] = [];
    let closed = false;
    let terminalSawClosed = false;
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
      ],
      {
        ...fakeDeps({
          onClose: () => {
            closed = true;
          },
        }),
        writeStdout: (text) => {
          lines.push(text.trim());
          if (text.includes('"type":"outcome"')) terminalSawClosed = closed;
        },
      },
    );

    assert.equal(result, 0);
    assert.equal(terminalSawClosed, true);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]!).type, 'start');
    assert.equal(JSON.parse(lines[1]!).type, 'runtime_event');
    assert.equal(JSON.parse(lines[2]!).type, 'outcome');
    assert.equal(JSON.parse(lines[2]!).status, 'completed');
    assert.equal(lines.join('\n').includes('sk-test-secret'), false);
  });

  test('emits a terminal fatal outcome for malformed JSON input', async () => {
    const lines: string[] = [];
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
      ],
      {
        ...fakeDeps({ input: '{"schemaVersion": 1' }),
        newId: () => 'generated-id',
        writeStdout: (text) => lines.push(text.trim()),
      },
    );

    assert.equal(result, 2);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).type),
      ['start', 'outcome'],
    );
    assert.deepEqual(JSON.parse(lines.at(-1)!), {
      protocol: 'maka.activation',
      schemaVersion: 1,
      type: 'outcome',
      activationId: 'generated-id',
      cloudSessionId: 'unknown',
      status: 'fatal_failure',
      reason: 'malformed_input',
    });
  });

  test('returns blocked after denying a non-interactive sandbox boundary request', async () => {
    const lines: string[] = [];
    const responses: Array<{ requestId: string; decision: 'deny' }> = [];
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
      ],
      {
        ...fakeDeps({
          result: {
            ...completedResult(),
            status: 'failed',
            finalOutput: undefined,
            failure: { class: 'permission_denied' },
            sandboxBoundary: 'unresolved',
          },
          onSandboxBoundaryResponse: (response) => responses.push(response),
          events: [
            {
              type: 'sandbox_boundary_request',
              id: 'boundary-event',
              turnId: 'turn-1',
              ts: 1,
              requestId: 'boundary-1',
              toolUseId: 'tool-1',
              justification: 'write generated output',
              expansion: {
                filesystem: {
                  entries: [{ path: '/tmp/output', access: 'write', scope: 'subtree' }],
                },
              },
            },
          ],
        }),
        writeStdout: (text) => lines.push(text.trim()),
      },
    );

    assert.equal(result, 3);
    assert.deepEqual(responses, [{ requestId: 'boundary-1', decision: 'deny' }]);
    assert.equal(JSON.parse(lines.at(-1)!).status, 'blocked');
    assert.equal(JSON.parse(lines.at(-1)!).reason, 'permission_denied');
  });

  test('returns blocked for an unresolved production sandbox tool failure', async () => {
    const lines: string[] = [];
    const boundaryFailure = {
      kind: 'text',
      text: 'Write requires an approved session sandbox boundary expansion.',
      sandboxFailure: {
        reason: 'sandbox_boundary_required',
        requiredExpansion: {
          filesystem: {
            entries: [{ path: '/tmp/output', access: 'write', scope: 'subtree' }],
          },
        },
      },
    } as const;
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
      ],
      {
        ...fakeDeps({
          result: {
            ...completedResult(),
            finalOutput: 'continued after the failed write',
            sandboxBoundary: 'unresolved',
          },
          events: [
            {
              type: 'tool_result',
              id: 'event-boundary-result',
              turnId: 'turn-1',
              ts: 1,
              toolUseId: 'tool-boundary',
              isError: true,
              content: boundaryFailure,
            },
          ],
        }),
        writeStdout: (text) => lines.push(text.trim()),
      },
    );

    assert.equal(result, 3);
    assert.deepEqual(JSON.parse(lines.at(-1)!), {
      protocol: 'maka.activation',
      schemaVersion: 1,
      type: 'outcome',
      activationId: 'activation-1',
      cloudSessionId: 'cloud-session-1',
      makaSessionId: 'maka-session-1',
      status: 'blocked',
      reason: 'permission_required',
      requiredAction: 'grant_permission',
    });
  });

  test('retries non-permission blocked sessions instead of requesting permission', async () => {
    for (const blockedReason of ['auth', 'tool_failed'] as const) {
      const lines: string[] = [];
      const result = await runMakaActivationCli(
        [
          '--state-root',
          ROOTS.stateRoot,
          '--workspace-root',
          ROOTS.workspaceRoot,
          '--config-root',
          ROOTS.configRoot,
        ],
        {
          ...fakeDeps({
            input: JSON.stringify(validRequest({ makaSessionId: 'maka-session-1' })),
            sessions: [summary({ status: 'blocked', blockedReason })],
          }),
          writeStdout: (text) => lines.push(text.trim()),
        },
      );

      assert.equal(result, 4);
      assert.deepEqual(JSON.parse(lines.at(-1)!), {
        protocol: 'maka.activation',
        schemaVersion: 1,
        type: 'outcome',
        activationId: 'activation-1',
        cloudSessionId: 'cloud-session-1',
        makaSessionId: 'maka-session-1',
        status: 'retryable_failure',
        reason: blockedReason,
        requiredAction: 'retry_activation',
      });
    }
  });

  test('resumes an existing compatible session without creating another one', async () => {
    let created = false;
    let resumed = false;
    let requestedConnection: string | undefined;
    const lines: string[] = [];
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
      ],
      {
        ...fakeDeps({
          input: JSON.stringify(validRequest({ makaSessionId: 'maka-session-1' })),
          sessions: [summary()],
          onCreateSession: () => {
            created = true;
          },
          onContext: (input) => {
            requestedConnection = input.requestedConnectionSlug;
          },
          safeBoundaryResume: true,
          onResume: () => {
            resumed = true;
          },
        }),
        writeStdout: (text) => lines.push(text.trim()),
      },
    );

    assert.equal(result, 0);
    assert.equal(created, false);
    assert.equal(resumed, true);
    assert.equal(requestedConnection, 'local');
    assert.equal(JSON.parse(lines.at(-1)!).makaSessionId, 'maka-session-1');
  });

  test('maps timeout to retryable_failure and emits one terminal outcome', async () => {
    const lines: string[] = [];
    let release: (() => void) | undefined;
    const result = await runMakaActivationCli(
      [
        '--state-root',
        ROOTS.stateRoot,
        '--workspace-root',
        ROOTS.workspaceRoot,
        '--config-root',
        ROOTS.configRoot,
        '--timeout',
        '0.01',
      ],
      {
        ...fakeDeps({
          sendMessage: async function* () {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        }),
        writeStdout: (text) => lines.push(text.trim()),
      },
    );
    release?.();

    assert.equal(result, 4);
    const outcomes = lines.filter((line) => JSON.parse(line).type === 'outcome');
    assert.equal(outcomes.length, 1);
    assert.deepEqual(JSON.parse(outcomes[0]!), {
      protocol: 'maka.activation',
      schemaVersion: 1,
      type: 'outcome',
      activationId: 'activation-1',
      cloudSessionId: 'cloud-session-1',
      makaSessionId: 'maka-session-1',
      status: 'retryable_failure',
      reason: 'timeout',
    });
  });
});

describe('maka activate filesystem boundaries', () => {
  test('rejects workspace/state/config overlap before bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-activation-'));
    try {
      await mkdir(join(root, 'state'));
      await mkdir(join(root, 'workspace'));
      const lines: string[] = [];
      const result = await runMakaActivationCli(
        [
          '--state-root',
          join(root, 'state'),
          '--workspace-root',
          root,
          '--config-root',
          join(root, 'config'),
        ],
        {
          ...fakeDeps(),
          writeStdout: (text) => lines.push(text.trim()),
        },
      );
      assert.equal(result, 2);
      assert.equal(JSON.parse(lines.at(-1)!).reason, 'unsafe_roots');
      await assert.rejects(access(join(root, 'config')), { code: 'ENOENT' });

      const reverseLines: string[] = [];
      const reverseResult = await runMakaActivationCli(
        [
          '--state-root',
          join(root, 'state'),
          '--workspace-root',
          join(root, 'workspace'),
          '--config-root',
          root,
        ],
        {
          ...fakeDeps(),
          writeStdout: (text) => reverseLines.push(text.trim()),
        },
      );
      assert.equal(reverseResult, 2);
      assert.equal(JSON.parse(reverseLines.at(-1)!).reason, 'unsafe_roots');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
