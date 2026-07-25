import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type {
  PermissionMode,
  PermissionRequestEvent,
  PermissionResponse,
  ToolCategory,
} from '@maka/core';
import { preToolUse } from '@maka/core';
import { PermissionPrompt } from '../src/permission-dialog.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Permission Prompt',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function PermissionPromptStory(props: Omit<Parameters<typeof PermissionPrompt>[0], 'onStop'>) {
  return <PermissionPrompt {...props} onStop={() => undefined} />;
}

const NOW = Date.now();

/**
 * Build the fixture the way the runtime builds it, by asking the authoritative
 * classifier (#1433).
 *
 * Every request below used to spell out its own `category`, `reason` and
 * `rememberForTurnAllowed`, and four of them named combinations `preToolUse`
 * cannot produce: `rm -rf …` reads as `fs_destructive`, not `shell_unsafe`;
 * `git clean -fdx` reads as `shell_unsafe`, not `fs_destructive`; WebFetch is
 * `web_read`, whose reason falls through to `custom` because `categoryToReason`
 * has no `web_read` arm; and `maka_computer` never allows remember-for-turn.
 * Hand-written fixtures drift silently — a story keeps rendering, it just stops
 * being the thing it claims to be.
 *
 * Only the caller's `mode` is a real input: `custom_tool` prompts in `explore`
 * and is allowed everywhere else, so a story has to say which session it is in.
 * If the mode does not actually prompt, this throws where you can see it.
 */
function makeRequest(input: {
  requestId: string;
  toolName: string;
  args: unknown;
  /** The session's permission mode. Defaults to `ask`, the shipped default. */
  mode?: PermissionMode;
  /** Trusted runtime hint for custom tools, exactly as the runtime passes it. */
  categoryHint?: ToolCategory;
  hint?: string;
  ageMs?: number;
}): PermissionRequestEvent {
  const mode = input.mode ?? 'ask';
  const decision = preToolUse({
    toolName: input.toolName,
    args: input.args,
    mode,
    turnRemembered: new Set(),
    ...(input.categoryHint ? { categoryHint: input.categoryHint } : {}),
  });
  if (!decision.needsPrompt || !decision.partialRequest) {
    throw new Error(
      `${input.toolName} does not prompt in "${mode}" mode — this story shows a prompt the runtime never raises`,
    );
  }
  return {
    ...decision.partialRequest,
    id: `evt-${input.requestId}`,
    turnId: `turn-${input.requestId}`,
    type: 'permission_request',
    requestId: input.requestId,
    toolUseId: `${input.requestId}-call`,
    ts: NOW - (input.ageMs ?? 0),
    ...(input.hint ? { hint: input.hint } : {}),
  };
}

function ComposerSlotBackdrop(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      {props.children}
    </div>
  );
}

const noop = () => undefined;

const writeStdinRequest = makeRequest({
  requestId: 'req-stdin',
  toolName: 'WriteStdin',
  args: {
    ref: 'maka://runtime/background-tasks/pty-1',
    input: `password=super-secret ${'diagnostic '.repeat(24)}\u001b[31mrm -rf /tmp/example\r`,
    size: { cols: 120, rows: 40 },
  },
});

function WriteStdinPrompt(props: {
  onRespond(response: PermissionResponse): void | Promise<void>;
}) {
  return (
    <ComposerSlotBackdrop>
      <PermissionPromptStory request={writeStdinRequest} onRespond={props.onRespond} />
    </ComposerSlotBackdrop>
  );
}

// Real path: chat → the agent runs a shell command that is not provably safe → the
// prompt takes over the composer slot (chat-composer-region.tsx). `shell_unsafe` is the
// fallback every unrecognized command lands in, so it is the most common shell prompt of
// all. This one also carries a hint, which only some requests have.
export const ShellDangerous: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-shell',
          toolName: 'Bash',
          args: { command: 'git clean -fdx', timeout_ms: 120000 },
          hint: '将删除所有未跟踪的文件和目录。',
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent writes to a running PTY's stdin → the prompt renders
// collapsed, with the raw bytes behind 查看输入 because stdin can carry secrets.
export const WriteStdin: Story = {
  render: () => <WriteStdinPrompt onRespond={noop} />,
};

const writeStdinRespond = fn();

// Real path: same as WriteStdin; the play function drives the user's own clicks — expand
// 查看输入, then 允许操作.
export const WriteStdinInteraction: Story = {
  render: () => <WriteStdinPrompt onRespond={writeStdinRespond} />,
  play: async ({ canvasElement }) => {
    writeStdinRespond.mockClear();
    const document = canvasElement.ownerDocument;
    const body = within(document.body);
    const collapsedText = document.body.textContent ?? '';

    await expect(collapsedText).toContain('maka://runtime/background-tasks/pty-1');
    await expect(collapsedText).toContain('120x40');
    await expect(collapsedText).not.toContain('super-secret');
    await expect(collapsedText).not.toContain('/tmp/example');
    await expect(body.queryByRole('checkbox')).toBeNull();

    await userEvent.click(body.getByRole('button', { name: '查看输入' }));
    const inspection = document.querySelector<HTMLElement>('.maka-permission-details .maka-code');
    await expect(inspection).not.toBeNull();
    const inspectionText = inspection?.textContent ?? '';
    await expect(inspectionText).toContain('super-secret');
    await expect(inspectionText).toContain(String.raw`\u{001B}[31mrm -rf /tmp/example\r`);
    await expect(inspectionText).not.toContain('\u001b');
    await expect(inspectionText).toContain('size: 120x40');

    await userEvent.click(body.getByRole('button', { name: '允许操作' }));
    await expect(writeStdinRespond).toHaveBeenCalledWith({
      requestId: 'req-stdin',
      decision: 'allow',
    });
  },
};

const fileWriteSentinel = 'FILE_WRITE_PRIVATE_SENTINEL';

// Real path: chat → the agent calls Write on a repo file → the prompt collapses the file
// body behind 查看内容.
export const FileWrite: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-write',
          toolName: 'Write',
          args: {
            path: 'src/renderer/app-shell.tsx',
            content: `import { AppShell } from "./app-shell";\n\n// ${fileWriteSentinel}\nexport function main() {\n  return <AppShell />;\n}\n`,
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    const body = within(document.body);

    await expect(document.body.textContent ?? '').not.toContain(fileWriteSentinel);
    await userEvent.click(body.getByRole('button', { name: '查看内容' }));
    await expect(document.body.textContent ?? '').toContain(fileWriteSentinel);
  },
};

// Real path: chat → the agent calls Edit with a short replacement → the diff fits
// inline, no disclosure needed.
export const FileEdit: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-edit',
          toolName: 'Edit',
          args: {
            path: 'packages/ui/src/composer.tsx',
            old_string: 'const placeholder = "给 Maka 发消息…";',
            new_string: 'const placeholder = "问点什么…";',
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: same as FileEdit but with a long replacement, then the user clicks 查看变更 —
// the expanded branch of the same prompt.
export const FileEditExpanded: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-edit-expanded',
          toolName: 'Edit',
          args: {
            path: 'packages/ui/src/composer.tsx',
            old_string: 'const placeholder = "给 Maka 发消息…";\n'.repeat(18),
            new_string: 'const placeholder = "描述任务…";\n'.repeat(18),
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
  play: async ({ canvasElement }) => {
    await wait(0);
    const disclosure = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => (button.textContent ?? '').includes('查看变更'));
    disclosure?.click();
  },
};

// Real path: chat → the agent runs a command matching a filesystem-destructive pattern
// (`rm -rf`, Remove-Item, …) → the fs_destructive category of the same prompt. The
// classifier scans every statement segment, so the `&& npm ci` tail does not hide it.
export const FsDestructive: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-fs',
          toolName: 'Bash',
          args: { command: 'rm -rf node_modules dist && npm ci' },
          hint: '这条命令会删除目录再重装依赖，请确认在正确的项目根目录执行。',
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent runs a history-rewriting git command (push --force) → the
// git_destructive category.
export const GitDestructive: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-git',
          toolName: 'Bash',
          args: { command: 'git push --force origin main' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent calls WebFetch (or WebSearch) → the web_read category,
// with the URL as the reviewable argument. Worth having as its own story because
// `categoryToReason` has no `web_read` arm: the reason falls through to `custom`, so this
// prompt renders the generic reason copy rather than a network-specific line.
export const WebRead: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-net',
          toolName: 'WebFetch',
          args: { url: 'https://api.github.com/repos/maka-agent/maka/releases/latest' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent runs a sudo command → the privileged category.
export const Privileged: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-sudo',
          toolName: 'Bash',
          args: { command: 'sudo systemctl restart maka-agent' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent drives the browser tool → the browser category.
export const Browser: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-browser',
          toolName: 'browser_navigate',
          categoryHint: 'browser',
          args: { url: 'https://example.com', ref: 'main' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent takes a screen action through maka_computer → the
// computer_use category, which shows the action and its target window instead of a
// command.
export const ComputerUse: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-computer-use',
          toolName: 'maka_computer',
          categoryHint: 'computer_use',
          args: {
            action: 'left_click',
            approvalClass: 'pointer_mutation',
            app: 'Example App',
            windowId: 42,
            observationId: 'frame-7',
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: chat → the agent edits an Office document → file_write with a structured
// operation rather than a text diff. `set` on an existing paragraph, because the tool's
// four operations are create/add/set/remove (office-document-tool.ts) — this fixture
// said `replaceText` and shipped a prompt line the app cannot produce. `preToolUse`
// does not catch that: it classifies the call, the tool's own Zod schema is what
// rejects it, and it rejects before the permission engine ever runs. `elementType` and
// `index` went with it; the schema documents both as `add`-only.
export const OfficeDocumentEdit: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-office',
          toolName: 'OfficeDocumentEdit',
          categoryHint: 'file_write',
          args: {
            path: 'reports/Q3-roadmap.docx',
            operation: 'set',
            target: '/body/p[42]',
            props: { text: 'Q3 目标：补齐 Storybook 表面覆盖。' },
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// Real path: an unanswered prompt that has been sitting for a few minutes — the user
// came back to the session after stepping away.
export const StaleRequest: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-stale',
          toolName: 'Bash',
          args: { command: 'npm run build && npm run test' },
          ageMs: 3 * 60_000,
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

// No `expired` story: no user can reach that state. The UI calls a request expired at
// PERMISSION_REQUEST_EXPIRED_AFTER_MS (10 minutes, permission-request-health.ts), but the
// runtime cancels the request at DEFAULT_PERMISSION_TIMEOUT_MS (5 minutes,
// tool-runtime.ts) and the resulting tool_result dequeues the prompt
// (app-shell-session-events.ts). The prompt is gone five minutes before the UI would
// call it expired. The story here claimed an 11-minute request, which is exactly the
// kind of confidently-worded impossibility this convention exists to catch — the
// mismatch between the two thresholds is a real defect, but it is a product fix, not a
// story fix, so it does not get a fake screenshot in the meantime.

// Real path: a Deep Research session (permission mode `explore`) → a custom tool that
// declares its own category → the fallback rendering for reasons the UI has no bespoke
// copy for. `custom_tool` is `prompt` only under `explore`; every other mode allows it
// outright, so this prompt is unreachable in an ordinary chat.
export const CustomReason: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-custom',
          toolName: 'MemoryWrite',
          mode: 'explore',
          categoryHint: 'custom_tool',
          args: { scope: 'project', content: '本仓库使用 pnpm，不要调用 npm install。' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

async function wait(ms: number) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

// Real path: the user clicks 允许 and the main process has not answered yet — the
// in-flight state between click and resolution.
export const SubmitPending: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-pending',
          toolName: 'Bash',
          args: { command: 'npm run deploy' },
        })}
        onRespond={() => new Promise<void>(() => undefined)}
      />
    </ComposerSlotBackdrop>
  ),
  play: async ({ canvasElement }) => {
    await wait(0);
    const allow = Array.from(canvasElement.ownerDocument.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => (button.textContent ?? '').includes('允许'));
    allow?.click();
  },
};
