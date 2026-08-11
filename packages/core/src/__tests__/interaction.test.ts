import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  INTERACTION_BROWSER_TEXT_PREVIEW_MAX_BYTES,
  INTERACTION_AUTO_REVIEW_RATIONALE_MAX_CHARS,
  INTERACTION_GENERIC_TOOL_ARGUMENTS_MAX_BYTES,
  INTERACTION_MAX_QUESTIONS,
  INTERACTION_REQUEST_MAX_BYTES,
  InteractionPermissionProjectionError,
  decodeInteractionAnswer,
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  interactionCanonicalOutcomesEquivalent,
  isInteractionAnswerValidForRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  projectInteractionPermissionRequest,
  projectInteractionQuestionRequest,
  projectInteractionSandboxBoundaryRequest,
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
      command:
        'curl -H "Authorization: Bearer super-secret-token" -H "Proxy-Authorization: Basic proxy-secret" example.test password=\'correct-horse-battery-staple\'',
    };
    const projected = projectInteractionPermissionRequest(request);
    assert.equal(projected.prompt.kind, 'tool_permission');
    assert.equal(projected.prompt.review.kind, 'command');
    if (projected.prompt.review.kind !== 'command') return;
    assert.match(projected.prompt.review.command, /Authorization: Bearer \[redacted\]/);
    assert.match(projected.prompt.review.command, /Proxy-Authorization: Basic \[redacted\]/);
    assert.match(projected.prompt.review.command, /password='\[redacted\]'/);
    assert.doesNotMatch(
      projected.prompt.review.command,
      /super-secret-token|proxy-secret|correct-horse-battery-staple/,
    );
    assert.deepEqual(request.args, {
      command:
        'curl -H "Authorization: Bearer super-secret-token" -H "Proxy-Authorization: Basic proxy-secret" example.test password=\'correct-horse-battery-staple\'',
    });
  });

  test('redacts standard secret access keys in Bash and generic reviews', () => {
    const command =
      'aws configure set aws_secret_access_\\\nkey \\\nconfig-secret && aws s3 cp . s3://bucket --secret-access-\\\r\nkey flag-\\\nsecret && AWS_SECRET_ACCESS_\\\nKEY\\\n=environment-secret curl -H "awsSecretAccessKey=aws-secret" -H "secretAccessKey=standard-secret" -H "accessKey=ordinary-access-key" example.test && tool --secret-access-key-\\\nfile visible-file';
    const bashRequest = {
      ...toolPermission,
      args: { command },
    };
    const bash = projectInteractionPermissionRequest(bashRequest);
    assert.equal(bash.prompt.kind, 'tool_permission');
    assert.equal(bash.prompt.review.kind, 'command');
    if (bash.prompt.review.kind !== 'command') return;
    assert.doesNotMatch(
      bash.prompt.review.command,
      /config-secret|flag-secret|aws-secret|standard-secret|environment-secret/,
    );
    assert.match(
      bash.prompt.review.command,
      /aws configure set aws_secret_access_\\\\u\{A\}key \\\\u\{A\}\[redacted\]/,
    );
    assert.match(bash.prompt.review.command, /--secret-access-\\\\u\{D\}\\u\{A\}key \[redacted\]/);
    assert.match(
      bash.prompt.review.command,
      /AWS_SECRET_ACCESS_\\\\u\{A\}KEY\\\\u\{A\}=\[redacted\]/,
    );
    assert.match(bash.prompt.review.command, /accessKey=ordinary-access-key/);
    assert.match(bash.prompt.review.command, /visible-file/);
    assert.deepEqual(bashRequest.args, { command });

    const generic = projectInteractionPermissionRequest({
      ...toolPermission,
      toolName: 'mcp__aws__invoke',
      category: 'network_send',
      reason: 'network',
      args: {
        awsSecretAccessKey: 'aws-secret',
        secretAccessKey: 'standard-secret',
        AWS_SECRET_ACCESS_KEY: 'environment-secret',
        accessKey: 'ordinary-access-key',
      },
    });
    assert.equal(generic.prompt.kind, 'tool_permission');
    assert.equal(generic.prompt.review.kind, 'tool');
    if (generic.prompt.review.kind !== 'tool') return;
    assert.doesNotMatch(
      generic.prompt.review.arguments.text,
      /aws-secret|standard-secret|environment-secret/,
    );
    assert.match(generic.prompt.review.arguments.text, /"accessKey":"ordinary-access-key"/);
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

  test('projects generic registered tools as stable bounded redacted reviews', () => {
    const mcpArgs = {
      toolName: 'create_issue',
      arguments: {
        body: 'x'.repeat(5000),
        client_secret: 'mcp-client-secret',
        issue_key: 'ISSUE-1359',
        objectKey: 'approval-target',
        owner: 'maka-agent',
        private_key: 'mcp-private-key',
        recipient: 'maintainer@example.com',
        refresh_token: 'mcp-refresh-token',
        service_account_key: 'mcp-service-account-key',
        session_token: 'mcp-session-token',
        ssh_private_key: 'mcp-ssh-private-key',
      },
      serverId: 'github',
    };
    const mcp = projectInteractionPermissionRequest({
      ...toolPermission,
      toolName: 'mcp__github__create_issue',
      category: 'network_send',
      reason: 'network',
      args: mcpArgs,
    });
    assert.equal(mcp.prompt.kind, 'tool_permission');
    assert.equal(mcp.prompt.review.kind, 'tool');
    if (mcp.prompt.review.kind !== 'tool') return;
    assert.equal(mcp.prompt.review.arguments.truncated, true);
    assert.equal(
      mcp.prompt.review.arguments.bytes,
      new TextEncoder().encode(
        `{"arguments":{"body":"${'x'.repeat(5000)}","client_secret":"mcp-client-secret","issue_key":"ISSUE-1359","objectKey":"approval-target","owner":"maka-agent","private_key":"mcp-private-key","recipient":"maintainer@example.com","refresh_token":"mcp-refresh-token","service_account_key":"mcp-service-account-key","session_token":"mcp-session-token","ssh_private_key":"mcp-ssh-private-key"},"serverId":"github","toolName":"create_issue"}`,
      ).byteLength,
    );
    assert.match(mcp.prompt.review.arguments.text, /"body":"x+\.\.\."/);
    assert.match(mcp.prompt.review.arguments.text, /"issue_key":"ISSUE-1359"/);
    assert.match(mcp.prompt.review.arguments.text, /"objectKey":"approval-target"/);
    assert.match(mcp.prompt.review.arguments.text, /"recipient":"maintainer@example\.com"/);
    assert.match(mcp.prompt.review.arguments.text, /"client_secret":"\[redacted\]"/);
    assert.match(mcp.prompt.review.arguments.text, /"private_key":"\[redacted\]"/);
    assert.match(mcp.prompt.review.arguments.text, /"refresh_token":"\[redacted\]"/);
    assert.match(mcp.prompt.review.arguments.text, /"service_account_key":"\[redacted\]"/);
    assert.match(mcp.prompt.review.arguments.text, /"session_token":"\[redacted\]"/);
    assert.match(mcp.prompt.review.arguments.text, /"ssh_private_key":"\[redacted\]"/);
    assert.doesNotMatch(
      mcp.prompt.review.arguments.text,
      /mcp-client-secret|mcp-private-key|mcp-refresh-token|mcp-service-account-key|mcp-session-token|mcp-ssh-private-key/,
    );
    assert.deepEqual(decodeInteractionRequest(mcp), mcp);
    assert.deepEqual(mcpArgs, {
      toolName: 'create_issue',
      arguments: {
        body: 'x'.repeat(5000),
        client_secret: 'mcp-client-secret',
        issue_key: 'ISSUE-1359',
        objectKey: 'approval-target',
        owner: 'maka-agent',
        private_key: 'mcp-private-key',
        recipient: 'maintainer@example.com',
        refresh_token: 'mcp-refresh-token',
        service_account_key: 'mcp-service-account-key',
        session_token: 'mcp-session-token',
        ssh_private_key: 'mcp-ssh-private-key',
      },
      serverId: 'github',
    });

    const agent = projectInteractionPermissionRequest({
      ...toolPermission,
      toolName: 'agent_spawn',
      category: 'subagent',
      reason: 'custom',
      args: {
        task: `password=agent-secret ${'界'.repeat(20_000)}`,
        profile: 'explorer',
      },
    });
    assert.equal(agent.prompt.kind, 'tool_permission');
    assert.equal(agent.prompt.review.kind, 'tool');
    if (agent.prompt.review.kind !== 'tool') return;
    assert.equal(agent.prompt.review.arguments.truncated, true);
    assert.ok(agent.prompt.review.arguments.bytes > INTERACTION_GENERIC_TOOL_ARGUMENTS_MAX_BYTES);
    assert.ok(
      new TextEncoder().encode(agent.prompt.review.arguments.text).byteLength <=
        INTERACTION_GENERIC_TOOL_ARGUMENTS_MAX_BYTES,
    );
    assert.match(agent.prompt.review.arguments.text, /"profile":"explorer"/);
    assert.doesNotMatch(agent.prompt.review.arguments.text, /agent-secret/);
    assert.deepEqual(decodeInteractionRequest(agent), agent);
  });

  test('redacts multiline assignments in generic string fields without dropping later commands', () => {
    const projected = projectInteractionPermissionRequest({
      ...toolPermission,
      toolName: 'mcp__deploy__run',
      category: 'network_send',
      reason: 'network',
      args: {
        script: 'review note\npassword=dummy-value\nrun visible',
      },
    });
    assert.equal(projected.prompt.kind, 'tool_permission');
    assert.equal(projected.prompt.review.kind, 'tool');
    if (projected.prompt.review.kind !== 'tool') return;

    assert.deepEqual(JSON.parse(projected.prompt.review.arguments.text), {
      script: 'review note\npassword=[redacted]\nrun visible',
    });
    assert.doesNotMatch(projected.prompt.review.arguments.text, /dummy-value/);
  });

  test('redacts authorization in generic string fields without consuming the next line', () => {
    const projected = projectInteractionPermissionRequest({
      ...toolPermission,
      toolName: 'mcp__deploy__run',
      category: 'network_send',
      reason: 'network',
      args: {
        request: 'Authorization: Bearer opaque-value\nrun visible',
      },
    });
    assert.equal(projected.prompt.kind, 'tool_permission');
    assert.equal(projected.prompt.review.kind, 'tool');
    if (projected.prompt.review.kind !== 'tool') return;

    assert.deepEqual(JSON.parse(projected.prompt.review.arguments.text), {
      request: 'Authorization: Bearer [redacted]\nrun visible',
    });
    assert.doesNotMatch(projected.prompt.review.arguments.text, /opaque-value/);
  });

  test('preserves short generic tool fields and fails closed when they exceed the preview cap', () => {
    const projected = projectInteractionPermissionRequest({
      ...toolPermission,
      toolName: 'mcp__mail__send',
      category: 'network_send',
      reason: 'network',
      args: {
        recipient: 'maintainer@example.com',
        serverId: 'mail',
        toolName: 'send',
        body: 'x'.repeat(20_000),
      },
    });
    assert.equal(projected.prompt.kind, 'tool_permission');
    assert.equal(projected.prompt.review.kind, 'tool');
    if (projected.prompt.review.kind !== 'tool') return;
    assert.match(projected.prompt.review.arguments.text, /"recipient":"maintainer@example\.com"/);
    assert.match(projected.prompt.review.arguments.text, /"serverId":"mail"/);
    assert.match(projected.prompt.review.arguments.text, /"toolName":"send"/);
    assert.doesNotMatch(
      projected.prompt.review.arguments.text,
      /"recipient":""|"serverId":""|"toolName":""/,
    );

    assert.throws(
      () =>
        projectInteractionPermissionRequest({
          ...toolPermission,
          toolName: 'mcp__mail__send',
          category: 'network_send',
          reason: 'network',
          args: Object.fromEntries(
            Array.from({ length: 500 }, (_, index) => [`field${index}`, `short-${index}`]),
          ),
        }),
      (error) => error instanceof InteractionPermissionProjectionError,
    );
  });

  test('fails closed for unrepresentable requests and malformed known optional fields', () => {
    const invalid: PermissionRequestPayload[] = [
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

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(
      () =>
        projectInteractionPermissionRequest({
          ...toolPermission,
          toolName: 'agent_spawn',
          category: 'subagent',
          reason: 'custom',
          args: cyclic,
        }),
      (error) => error instanceof InteractionPermissionProjectionError,
    );
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

  test('visibly escapes every omitted Bidi_Control code point in review labels', () => {
    const projected = projectInteractionQuestionRequest({
      toolUseId: 'question-tool',
      questions: [
        {
          question: 'Choose',
          options: [{ label: '\u061cArabic' }, { label: '\u200eLTR' }, { label: '\u200fRTL' }],
        },
      ],
    });

    assert.deepEqual(projected.questions[0]?.options, [
      { label: '\\u{61C}Arabic' },
      { label: '\\u{200E}LTR' },
      { label: '\\u{200F}RTL' },
    ]);
  });

  test('rejects labels that collide with a Bidi_Control visible escape', () => {
    assert.throws(() =>
      projectInteractionQuestionRequest({
        toolUseId: 'question-tool',
        questions: [
          {
            question: 'Choose',
            options: [{ label: '\u200eLTR' }, { label: '\\u{200E}LTR' }],
          },
        ],
      }),
    );
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
  test('accepts independently bounded sandbox fields without an invented combined cap', () => {
    const request = projectInteractionSandboxBoundaryRequest({
      expansion: {
        filesystem: {
          entries: Array.from({ length: 32 }, (_, index) => ({
            path: `/opt/service-${index}/${'x'.repeat(1_980)}`,
            access: 'read' as const,
            scope: 'exact' as const,
          })),
        },
      },
      justification: '\u0001'.repeat(2_000),
    });

    assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') > 64 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') > INTERACTION_REQUEST_MAX_BYTES);
    assert.deepEqual(decodeInteractionRequest(request), request);
  });

  test('keeps sandbox boundary answers tied to exact boundary outcome semantics', () => {
    const request = projectInteractionSandboxBoundaryRequest({
      expansion: {
        filesystem: {
          entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
        },
      },
      justification: 'Read the selected file.',
    });
    const answer = decodeInteractionAnswer({ kind: 'sandbox_boundary', decision: 'allow' });
    const outcome = decodeInteractionCanonicalOutcome({
      kind: 'sandbox_boundary_decision',
      decision: 'allow',
      status: 'approved',
      committedAt: 2,
    });
    assert.equal(isInteractionAnswerValidForRequest(request, answer), true);
    assert.equal(isInteractionCanonicalOutcomeValidForRequest(request, outcome), true);
    assert.deepEqual(decodeInteractionRequest(request), request);
    assert.throws(() =>
      decodeInteractionCanonicalOutcome({
        kind: 'sandbox_boundary_decision',
        decision: 'deny',
        status: 'approved',
        committedAt: 2,
      }),
    );
    assert.equal(
      isInteractionCanonicalOutcomeValidForRequest(
        request,
        decodeInteractionCanonicalOutcome({
          kind: 'closure',
          reason: 'timed_out',
          committedAt: 3,
        }),
      ),
      false,
    );
  });

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

  test('decodes only bounded auto-review rationale', () => {
    const rationale = 'r'.repeat(INTERACTION_AUTO_REVIEW_RATIONALE_MAX_CHARS);
    const reviewed = decodeInteractionCanonicalOutcome({
      kind: 'permission_answer',
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'auto_review',
      rationale,
      committedAt: 1,
    });
    assert.equal(reviewed.kind, 'permission_answer');
    if (reviewed.kind !== 'permission_answer') return;
    assert.equal(reviewed.rationale, rationale);
    const retry = decodeInteractionCanonicalOutcome({
      kind: 'permission_answer',
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'auto_review',
      rationale: 'A retry may explain the same user-answer semantics differently.',
      committedAt: 2,
    });
    assert.equal(interactionCanonicalOutcomesEquivalent(reviewed, retry), true);
    assert.equal(
      retry.kind === 'permission_answer' ? retry.rationale : undefined,
      'A retry may explain the same user-answer semantics differently.',
    );

    assert.throws(() =>
      decodeInteractionCanonicalOutcome({
        kind: 'permission_answer',
        decision: 'allow',
        rememberForTurn: false,
        reviewer: 'auto_review',
        rationale: `${rationale}x`,
        committedAt: 4,
      }),
    );
    assert.throws(() =>
      decodeInteractionCanonicalOutcome({
        kind: 'permission_answer',
        decision: 'allow',
        rememberForTurn: false,
        reviewer: 'user',
        rationale: 'User wire answers cannot adjudicate themselves.',
        committedAt: 5,
      }),
    );
    assert.throws(() =>
      decodeInteractionAnswer({
        kind: 'permission',
        decision: 'allow',
        rememberForTurn: false,
        rationale: 'not on the user answer wire',
      }),
    );
  });
});
