import type { Meta, StoryObj } from '@storybook/react-vite';
import { Markdown, MakaUriContext } from '../src/markdown.js';
import { Bubble } from '../src/primitives/chat.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Markdown',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function ProseFrame(props: { children: React.ReactNode; width?: number }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        padding: 24,
      }}
    >
      <div style={{ margin: '0 auto', maxWidth: props.width ?? 720, width: '100%' }}>
        {props.children}
      </div>
    </div>
  );
}

// Build a fenced code block without dropping raw backticks into a JS
// template literal (which makes the closing fence eat the template's
// terminating backtick).
function code(lang: string, body: string): string {
  const open = '```' + lang;
  const close = '```';
  return [open, body, close].join('\n');
}

const noop = () => undefined;

const tsBlock = code('ts', [
  'type SessionGroup = {',
  '  id: "pinned" | "recent";',
  '  label: string;',
  '  sessions: SessionSummary[];',
  '};',
  '',
  'export function groupConversations(',
  '  sessions: readonly SessionSummary[],',
  '): SessionGroup[] {',
  '  return [];',
  '}',
].join('\n'));

const bashBlock = code('bash', 'npm run build && npm run test');

const jsonBlock = code('json', [
  '{',
  '  "status": "running",',
  '  "sessionId": "session-42",',
  '  "startedAt": 1782000000000',
  '}',
].join('\n'));

const plainBlock = code('', 'plain or unknown\nindented sample');

// Real path: chat → an assistant answer that mixes headings, emphasis, a list, a quote
// and a table — the ordinary shape of a long reply.
export const RichAssistantAnswer: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '## 改动思路',
            '',
            '这次把会话列表收敛成置顶和最近两段，状态只保留在行图标上。好处是**所有会话都遵循同一条时间排序规则**，不会因为生命周期变化突然跳到别的分组。',
            '',
            '主要做了三件事：',
            '',
            '1. 置顶会话固定在最上方；',
            '2. 其余会话按最近活动时间排序；',
            '3. 运行中、等待和阻塞等状态只显示为低干扰行图标。',
            '',
            '> 注意：按项目视图仍然保留项目折叠，扁平化只作用于按时间视图。',
            '',
            '| 行状态 | 视觉标识 | 是否改变分组 |',
            '| --- | --- | --- |',
            '| running | 旋转图标 | 否 |',
            '| waiting_for_user | 等待图标 | 否 |',
            '| blocked | 警示图标 | 否 |',
            '| active | 无图标 | 否 |',
            '',
            '如果后续要加新状态，只需补充对应的行图标，不再扩张侧栏信息架构。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

// Real path: chat → an assistant answer containing fenced code in several languages,
// plus one unlabelled block.
export const CodeBlockVariety: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '下面是几种常见代码块，用来核对语言标签和复制按钮。',
            '',
            tsBlock,
            '',
            bashBlock,
            '',
            jsonBlock,
            '',
            '未标语言的代码块也会被高亮：',
            '',
            plainBlock,
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

// Real path: chat → an assistant answer built mostly from nested lists and block quotes.
export const ListsAndQuote: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '可以按下面顺序处理：',
            '',
            '- 先确认会话排序的权威时间',
            '  - 置顶的浮在最上面',
            '  - 其余会话统一按最近活动排序',
            '- 再调整侧栏渲染',
            '- 最后补回归测试',
            '',
            '1. 读 `session-history-list.tsx`',
            '2. 改 `session-list-panel.tsx`',
            '3. 跑 `npm run test`',
            '',
            '> 这里的顺序不是强制的，只要回归测试先跑就行。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

// Real path: chat → an assistant answer containing links. Only ChatView installs
// MakaUriContext (app-shell.tsx), so this is where maka:// links navigate and unsafe
// ones render as 链接无效.
export const LinkRouting: Story = {
  render: () => (
    <ProseFrame>
      <MakaUriContext.Provider value={noop}>
        <Bubble variant="assistant" className="maka-bubble-with-actions">
          <Markdown
            text={[
              '这里有三类链接，用来核对内部路由和安全过滤。',
              '',
              '外链会新窗口打开：[项目仓库](https://github.com/example/maka)。',
              '',
              '内部链接走应用内导航：',
              '- [去设置 · 模型](maka://settings?section=models)',
              '- [把这段写进输入框](maka://compose?text=帮我看看这个)',
              '',
              '下面这些会被拦成不可点的"链接无效"：',
              '',
              '- 不安全的 scheme：[点我](javascript:alert(1))',
              '- 内部链接但目标不合法：[坏链接](maka://tool/run)',
              '',
              '链接外的正文 `inline code` 和普通文字不受影响。',
            ].join('\n')}
          />
        </Bubble>
      </MakaUriContext.Provider>
    </ProseFrame>
  ),
};

// Tables shrink-wrap to content and only scroll when wider than the prose
// measure — this story pins the over-wide branch (frameless horizontal
// scroller) next to the narrow tables in the stories above.
// Real path: chat → an assistant answer whose table is wider than the prose measure, so
// it becomes a horizontal scroller.
export const WideTable: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '列多且内容长的表格会在正文宽度内横向滚动：',
            '',
            '| 会话 ID | 连接 | 模型 | 状态 | 最近一条消息时间 | 输入 tokens | 输出 tokens | 费用（USD） |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
            '| e2e-fixture-turn-control-primary | zai-live | glm-5.1 | waiting_for_user | 2026-07-07 18:42:11 | 125,032 | 32,480 | 0.4210 |',
            '| e2e-fixture-turn-control-branch-visible | zai-live | glm-5 | running | 2026-07-07 18:40:02 | 98,771 | 21,006 | 0.2988 |',
            '',
            '表格后的正文保持正常段落间距。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

// Real path: chat → a long assistant answer, pinned at the 680px prose measure to check
// vertical rhythm across many blocks.
export const LongFormArticle: Story = {
  render: () => (
    <ProseFrame width={680}>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '# Storybook 表面覆盖：为什么单独可看很重要',
            '',
            '当一次改动同时影响多个状态时，靠手动把桌面 app 驱动到每条路径太慢，也容易漏。把每个可见状态固定成 Storybook 的一帧，reviewer 可以逐个点开核对，回归截图也能自动比对。',
            '',
            '## 范围',
            '',
            '这次补的主要是高频但此前没有 story 的页面：',
            '',
            '- 权限弹窗（8 种 reason + 3 种 health）',
            '- 顶层布局（侧栏 + 主区 + overlay 堆叠）',
            '- 首次启动引导',
            '',
            '## 非目标',
            '',
            '`AppShell` 这个集成根不在 Storybook 里整体挂载。它深度依赖桌面 preload 的 IPC，整体挂载需要造一整套 mock，维护成本高、容易脆。改为用真实的子组件拼出布局，能稳定反映页面长什么样。',
            '',
            '| 页面 | 方式 | 原因 |',
            '| --- | --- | --- |',
            '| 权限弹窗 | 直接挂载 | 叶子组件，props 驱动 |',
            '| 顶层布局 | 组合子组件 | 避开 IPC 耦合 |',
            '| 设置各页 | 桥接 mock | 已有 `ConnectionsBridge` 模式 |',
            '',
            '## 验证',
            '',
            '写完后跑一次 `npm run build-storybook`，确认所有 story 编译通过；再视情况补回归截图。',
            '',
            '### 截图基线怎么补',
            '',
            '新 story 落地后跑一遍采集脚本，把首轮产物当作基线入库。',
            '',
            '#### 已知噪声',
            '',
            '字体渲染在不同 GPU 下有亚像素差异，比对时用容差阈值。',
            '',
            // hr; `***` instead of triple-dash so the storybook-baseline token
            // scan doesn't read the quoted literal as a custom-property token.
            '***',
            '',
            '以上是全部范围；有疑问先在 issue 里讨论再动手。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};
