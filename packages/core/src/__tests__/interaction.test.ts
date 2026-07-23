import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  INTERACTION_BROWSER_TEXT_PREVIEW_MAX_BYTES,
  INTERACTION_MAX_QUESTIONS,
  InteractionPermissionProjectionError,
  decodeInteractionAnswer,
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  interactionCanonicalOutcomesEquivalent,
  isInteractionAnswerValidForRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  projectInteractionPermissionRequest,
  projectInteractionQuestionRequest,
} from '../interaction.js';
import type { PermissionRequest, PermissionRequestPayload } from '../permission.js';

const toolPermission: PermissionRequest = {
  kind: 'tool_permission',
  requestId: 'request-1',
  toolUseId: 'tool-1',
  toolName: 'Bash',
  category: 'shell_unsafe',
  reason: 'shell_dangerous',
  args: {
    command: 'echo hello',
    cwd: '/repo',
    authorization: 'Bearer raw-secret',
  },
  rememberForTurnAllowed: true,
};

function browserPermission(toolName: string, args: unknown): PermissionRequestPayload {
  return {
    ...toolPermission,
    toolName,
    category: 'browser',
    reason: 'browser',
    args,
  };
}

describe('Interaction projection', () => {
  test('projects tool permission without retaining raw args or secrets', () => {
    const projected = projectInteractionPermissionRequest(toolPermission);
    assert.deepEqual(projected, {
      kind: 'permission',
      toolUseId: 'tool-1',
      prompt: {
        kind: 'tool_permission',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        review: { kind: 'command', command: 'echo hello', cwd: '/repo' },
        rememberForTurnAllowed: true,
      },
    });
    assert.doesNotMatch(JSON.stringify(projected), /raw-secret|args/);
  });

  test('redacts review secrets without changing execution args', () => {
    const request = structuredClone(toolPermission);
    if (request.kind !== 'tool_permission') throw new Error('Expected tool permission');
    request.args = {
      command: 'curl -H "Authorization: Bearer super-secret-token" example.test',
    };
    const projected = projectInteractionPermissionRequest(request);
    assert.match(JSON.stringify(projected), /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(projected), /super-secret-token/);
    assert.deepEqual(request.args, {
      command: 'curl -H "Authorization: Bearer super-secret-token" example.test',
    });
  });

  test('projects additional, sandbox, and all browser requests as exact closed reviews', () => {
    const cases: Array<{
      request: PermissionRequestPayload;
      expectedPrompt: unknown;
    }> = [
      {
        request: {
          kind: 'additional_permissions',
          requestId: 'r2',
          toolUseId: 't2',
          toolName: 'Write',
          category: 'file_write',
          reason: 'additional_permissions',
          additionalPermissions: {
            fileSystem: {
              entries: [{ path: '/outside/file', access: 'write', scope: 'exact' }],
            },
            network: { enabled: true },
          },
          cwd: '/repo',
          justification: 'raw private rationale',
          intentHash: 'secret-intent',
          permissionsHash: 'secret-permissions',
          risk: {
            outsideWorkspace: true,
            protectedMetadata: false,
            networkEnabled: true,
          },
          alsoApprovesToolExecution: true,
          availableDecisions: ['allow_once', 'deny'],
        },
        expectedPrompt: {
          kind: 'additional_permissions',
          toolName: 'Write',
          category: 'file_write',
          reason: 'additional_permissions',
          review: {
            kind: 'additional_permissions',
            cwd: '/repo',
            paths: [{ path: '/outside/file', access: 'write', scope: 'exact' }],
            networkEnabled: true,
          },
          risk: {
            outsideWorkspace: true,
            protectedMetadata: false,
            networkEnabled: true,
          },
          alsoApprovesToolExecution: true,
          availableDecisions: ['allow_once', 'deny'],
        },
      },
      {
        request: {
          kind: 'sandbox_escalation',
          requestId: 'r3',
          toolUseId: 't3',
          toolName: 'Bash',
          category: 'privileged',
          reason: 'sandbox_escalation',
          command: 'sudo true\u0007 password=raw-value',
          cwd: '/repo',
          justification: 'contains password=raw-value',
          intentHash: 'i',
          commandHash: 'c',
          trigger: 'proactive',
          risk: {
            unsandboxedExecution: true,
            unrestrictedFileSystem: true,
            unrestrictedNetwork: true,
            protectedMetadataExposed: true,
          },
          alsoApprovesToolExecution: true,
          availableDecisions: ['allow_once', 'deny'],
        },
        expectedPrompt: {
          kind: 'sandbox_escalation',
          toolName: 'Bash',
          category: 'privileged',
          reason: 'sandbox_escalation',
          review: {
            kind: 'command',
            command: 'sudo true\\u{7} password=[redacted]',
            cwd: '/repo',
          },
          trigger: 'proactive',
          risk: {
            unsandboxedExecution: true,
            unrestrictedFileSystem: true,
            unrestrictedNetwork: true,
            protectedMetadataExposed: true,
          },
          alsoApprovesToolExecution: true,
          availableDecisions: ['allow_once', 'deny'],
        },
      },
    ];

    for (const { request, expectedPrompt } of cases) {
      const projected = projectInteractionPermissionRequest(request);
      assert.deepEqual(projected.prompt, expectedPrompt);
      assert.doesNotMatch(
        JSON.stringify(projected),
        /private rationale|secret-intent|secret-permissions|raw-value/,
      );
    }

    const browserInput = `password=super-secret ${'x'.repeat(5000)}`;
    const browserCases: Array<{
      toolName: string;
      args: unknown;
      review: unknown;
    }> = [
      {
        toolName: 'browser_navigate',
        args: { url: 'https://example.test/path' },
        review: {
          kind: 'browser',
          action: 'navigate',
          url: 'https://example.test/path',
        },
      },
      {
        toolName: 'browser_snapshot',
        args: {},
        review: { kind: 'browser', action: 'snapshot' },
      },
      {
        toolName: 'browser_click',
        args: { ref: '[12]' },
        review: { kind: 'browser', action: 'click', ref: '[12]' },
      },
      {
        toolName: 'browser_type',
        args: { ref: '#search', text: browserInput, submit: true },
        review: {
          kind: 'browser',
          action: 'type',
          ref: '#search',
          input: {
            text: `password=[redacted] ${'x'.repeat(
              INTERACTION_BROWSER_TEXT_PREVIEW_MAX_BYTES - 20,
            )}`,
            bytes: new TextEncoder().encode(browserInput).byteLength,
            truncated: true,
          },
          submit: true,
        },
      },
      {
        toolName: 'browser_wait',
        args: { text: 'Ready', timeout: 200 },
        review: {
          kind: 'browser',
          action: 'wait',
          condition: 'text',
          value: 'Ready',
          timeoutSeconds: 120,
        },
      },
      {
        toolName: 'browser_extract',
        args: { selector: '.main', start: -2.5 },
        review: {
          kind: 'browser',
          action: 'extract',
          selector: '.main',
          start: 0,
        },
      },
    ];
    for (const browserCase of browserCases) {
      const projected = projectInteractionPermissionRequest(
        browserPermission(browserCase.toolName, browserCase.args),
      );
      assert.equal(projected.prompt.kind, 'tool_permission');
      assert.deepEqual(projected.prompt.review, browserCase.review);
      assert.deepEqual(decodeInteractionRequest(projected), projected);
    }
    assert.doesNotMatch(
      JSON.stringify(
        projectInteractionPermissionRequest(
          browserPermission('browser_type', {
            ref: '#search',
            text: browserInput,
            submit: true,
          }),
        ),
      ),
      /super-secret/,
    );
  });

  test('fails closed for unrepresentable requests and malformed known optional fields', () => {
    const invalid: PermissionRequestPayload[] = [
      {
        ...toolPermission,
        toolName: 'UnknownTool',
        category: 'custom_tool',
        reason: 'custom',
        args: { token: 'secret' },
      },
      { ...toolPermission, args: { command: 'x'.repeat(9000) } },
      { ...toolPermission, args: { command: 'echo ok', cwd: 42 } },
      { ...toolPermission, args: { command: 'echo ok', cwd: undefined } },
      {
        ...toolPermission,
        toolName: 'Grep',
        category: 'read',
        reason: 'custom',
        args: { pattern: 'needle', path: '/repo', glob: 42 },
      },
      {
        ...toolPermission,
        toolName: 'Grep',
        category: 'read',
        reason: 'custom',
        args: { pattern: 'needle', path: null, cwd: '/repo' },
      },
      {
        ...toolPermission,
        toolName: 'computer_use',
        category: 'computer_use',
        reason: 'computer_use',
        args: {
          action: 'observe',
          approvalClass: 'metadata_read',
          app: 42,
        },
      },
      {
        ...toolPermission,
        toolName: 'WriteStdin',
        args: { size: { cols: 0, rows: 24 } },
        rememberForTurnAllowed: false,
      },
      browserPermission('browser_unknown', {}),
      browserPermission('browser_type', {
        ref: '#search',
        text: 'hello',
        submit: 'yes',
      }),
      browserPermission('browser_wait', { text: 'Ready', time: 1 }),
      browserPermission('browser_extract', { selector: 42 }),
      {
        ...toolPermission,
        toolName: 'WriteStdin',
        args: { input: 42, size: { cols: 80, rows: 24 } },
        rememberForTurnAllowed: false,
      },
      {
        ...toolPermission,
        toolName: 'WriteStdin',
        args: { ref: null, size: { cols: 80, rows: 24 } },
        rememberForTurnAllowed: false,
      },
    ];
    for (const request of invalid) {
      assert.throws(
        () => projectInteractionPermissionRequest(request),
        (error) => error instanceof InteractionPermissionProjectionError,
      );
    }
  });

  test('projects bounded questions with exact arity', () => {
    assert.deepEqual(
      projectInteractionQuestionRequest({
        toolUseId: 'question-tool',
        questions: [
          {
            question: 'Proceed?',
            options: [{ label: 'Yes' }, { label: 'No', description: 'Stop here' }],
          },
        ],
      }),
      {
        kind: 'question',
        toolUseId: 'question-tool',
        questions: [
          {
            question: 'Proceed?',
            options: [{ label: 'Yes' }, { label: 'No', description: 'Stop here' }],
          },
        ],
      },
    );
    assert.throws(() => projectInteractionQuestionRequest({ toolUseId: 'q', questions: [] }));
    assert.throws(() =>
      projectInteractionQuestionRequest({
        toolUseId: 'q',
        questions: Array.from({ length: INTERACTION_MAX_QUESTIONS + 1 }, () => ({
          question: 'Q',
          options: [{ label: 'A' }, { label: 'B' }],
        })),
      }),
    );
    assert.throws(() =>
      projectInteractionQuestionRequest({
        toolUseId: 'q',
        questions: [{ question: 'Q', options: [{ label: 'only' }] }],
      }),
    );
  });

  test('projects secrets and unsafe review characters in question text', () => {
    const request = {
      toolUseId: 'question-tool',
      questions: [
        {
          question: '\u0007 password=question-secret',
          options: [
            { label: '\u202e token=label-secret', description: '\napi_key=description-secret' },
            { label: 'Keep' },
          ],
        },
      ],
    };

    const projected = projectInteractionQuestionRequest(request);

    assert.deepEqual(projected.questions, [
      {
        question: '\\u{7} password=[redacted]',
        options: [
          {
            label: '\\u{202E} token=[redacted]',
            description: '\\u{A}api_key=[redacted]',
          },
          { label: 'Keep' },
        ],
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(projected),
      /question-secret|label-secret|description-secret/,
    );
    assert.deepEqual(request.questions[0]?.options[0], {
      label: '\u202e token=label-secret',
      description: '\napi_key=description-secret',
    });
  });

  test('rejects option labels that collide after safe projection', () => {
    assert.throws(() =>
      projectInteractionQuestionRequest({
        toolUseId: 'question-tool',
        questions: [
          {
            question: 'Choose',
            options: [{ label: 'password=first-secret' }, { label: 'password=second-secret' }],
          },
        ],
      }),
    );
  });
});

describe('Interaction decoding and validity', () => {
  const permission = projectInteractionPermissionRequest(toolPermission);
  const question = projectInteractionQuestionRequest({
    toolUseId: 'q1',
    questions: [
      { question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Confirm', options: [{ label: 'Y' }, { label: 'N' }] },
    ],
  });

  test('strictly rejects widened shapes, sparse arrays, unsafe text, and serialized overflow', () => {
    const sparse = new Array(2);
    sparse[1] = 'answer';
    const invalid = [
      () =>
        decodeInteractionAnswer({
          kind: 'permission',
          decision: 'allow',
          rememberForTurn: false,
          extra: true,
        }),
      () => decodeInteractionRequest({ ...question, extra: true }),
      () => {
        const click = projectInteractionPermissionRequest(
          browserPermission('browser_click', { ref: '[1]' }),
        );
        return decodeInteractionRequest({
          ...click,
          prompt: {
            ...click.prompt,
            review: { kind: 'browser', action: 'snapshot' },
          },
        });
      },
      () => decodeInteractionAnswer({ kind: 'question', answers: sparse }),
      () =>
        decodeInteractionRequest({
          ...permission,
          prompt: {
            ...permission.prompt,
            review: { kind: 'command', command: 'echo\nsecret' },
          },
        }),
      () =>
        decodeInteractionAnswer({
          kind: 'question',
          answers: ['\\'.repeat(2048), '\\'.repeat(2048), '\\'.repeat(2048)],
        }),
      () =>
        projectInteractionQuestionRequest({
          toolUseId: 'q',
          questions: [
            {
              question: '界'.repeat(342),
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        }),
    ];
    for (const decode of invalid) assert.throws(decode);
  });

  test('validates answer kind, arity, deny, and remember eligibility', () => {
    assert.equal(
      isInteractionAnswerValidForRequest(
        permission,
        decodeInteractionAnswer({
          kind: 'permission',
          decision: 'allow',
          rememberForTurn: true,
        }),
      ),
      true,
    );
    assert.equal(
      isInteractionAnswerValidForRequest(
        question,
        decodeInteractionAnswer({ kind: 'question', answers: ['A', null] }),
      ),
      true,
    );
    assert.equal(
      isInteractionAnswerValidForRequest(
        question,
        decodeInteractionAnswer({ kind: 'question', answers: ['A'] }),
      ),
      false,
    );
    assert.throws(() =>
      decodeInteractionAnswer({
        kind: 'permission',
        decision: 'deny',
        rememberForTurn: true,
      }),
    );

    const additional = projectInteractionPermissionRequest({
      kind: 'additional_permissions',
      requestId: 'r',
      toolUseId: 't',
      toolName: 'Write',
      category: 'file_write',
      reason: 'additional_permissions',
      additionalPermissions: { network: { enabled: true } },
      cwd: '/repo',
      justification: 'network',
      intentHash: 'i',
      permissionsHash: 'p',
      risk: {
        outsideWorkspace: false,
        protectedMetadata: false,
        networkEnabled: true,
      },
      alsoApprovesToolExecution: false,
      availableDecisions: ['allow_once', 'deny'],
    });
    assert.equal(
      isInteractionAnswerValidForRequest(
        additional,
        decodeInteractionAnswer({
          kind: 'permission',
          decision: 'allow',
          rememberForTurn: true,
        }),
      ),
      false,
    );
  });

  test('validates canonical closures, equivalence, and safe integer commit times', () => {
    const first = decodeInteractionCanonicalOutcome({
      kind: 'permission_answer',
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'user',
      riskLevel: 'high',
      committedAt: 1,
    });
    const retry = decodeInteractionCanonicalOutcome({
      kind: 'permission_answer',
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'auto_review',
      riskLevel: 'low',
      committedAt: 2,
    });
    assert.equal(interactionCanonicalOutcomesEquivalent(first, retry), true);
    assert.equal(isInteractionCanonicalOutcomeValidForRequest(permission, first), true);

    const timeout = decodeInteractionCanonicalOutcome({
      kind: 'closure',
      reason: 'timed_out',
      committedAt: 3,
    });
    assert.equal(isInteractionCanonicalOutcomeValidForRequest(permission, timeout), true);
    assert.equal(isInteractionCanonicalOutcomeValidForRequest(question, timeout), false);
    assert.equal(
      interactionCanonicalOutcomesEquivalent(
        timeout,
        decodeInteractionCanonicalOutcome({
          kind: 'closure',
          reason: 'host_restarted',
          committedAt: 4,
        }),
      ),
      false,
    );
    for (const committedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() =>
        decodeInteractionCanonicalOutcome({
          kind: 'closure',
          reason: 'turn_terminal',
          committedAt,
        }),
      );
    }
  });
});
