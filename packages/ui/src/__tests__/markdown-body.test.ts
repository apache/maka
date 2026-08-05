import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import {
  applyMermaidRenderBudget,
  MarkdownBody,
  MAX_AUTOMATIC_MERMAID_DIAGRAMS,
  MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH,
  MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH,
} from '../markdown-body.js';
import { MakaUriContext, Markdown } from '../markdown.js';
import {
  AstryxLocaleProvider,
  astryxMessageOverrides,
} from '../astryx-i18n.js';
import { LocaleProvider } from '../locale-context.js';
import {
  calculateMermaidFitScale,
  createMermaidConfig,
  MAX_MERMAID_EDGES,
  MAX_MERMAID_SOURCE_LENGTH,
} from '../mermaid-diagram.js';

it('keeps raw HTML inert instead of expanding the Markdown trust surface', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '<details open><summary>Click</summary>payload</details>',
  }));

  assert.match(markup, /&lt;details open&gt;/);
  assert.doesNotMatch(markup, /<details/);
});

it('redacts secrets before even the lazy Markdown fallback reaches the rendered tree', () => {
  const markup = renderToStaticMarkup(createElement(Markdown, {
    text: 'Authorization: Bearer sk-live-1234567890abcdef',
  }));

  assert.doesNotMatch(markup, /sk-live-1234567890abcdef/);
  assert.match(markup, /&lt;redacted&gt;/);
});

it('renders Markdown through the Astryx document surface', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '# Heading\n\nparagraph',
  }));

  assert.match(markup, /<div[^>]*role="document"/);
  assert.match(markup, /<h1[^>]*>Heading<\/h1>/);
});

it('declares one stable migration scope around Astryx Markdown', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'paragraph',
  }));

  assert.match(markup, /^<div data-maka-contract="markdown"/);
  assert.match(markup, /<div[^>]*role="document"/);
});

it('preserves allowlisted Maka navigation links through sanitization', () => {
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(
          MakaUriContext.Provider,
          { value: () => {} },
          createElement(MarkdownBody, {
            text: '[Models](maka://settings/models)',
          }),
        ),
      },
    ),
  );

  assert.match(markup, /<button\b/);
  assert.match(markup, /data-maka-uri-kind="settings"/);
  assert.doesNotMatch(markup, /Blocked URL/);
});

it('uses the localized Astryx external-link affordance for safe URLs', () => {
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'zh',
        children: createElement(
          AstryxLocaleProvider,
          null,
          createElement(MarkdownBody, {
            text: '[项目仓库](https://github.com/maka-agent/maka-agent)',
          }),
        ),
      },
    ),
  );

  assert.match(markup, /<a\b/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, />（在新标签页中打开）</);
});

it('keeps non-allowlisted external schemes inert', () => {
  for (const href of [
    'file:///Users/example/.ssh/id_rsa',
    'custom://private-resource',
    'javascript:alert(1)',
    'data:text/html,private',
  ]) {
    const markup = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        {
          locale: 'en',
          children: createElement(MarkdownBody, {
            text: `[unsafe](${href})`,
          }),
        },
      ),
    );

    assert.doesNotMatch(markup, /<a\b/, href);
    if (href.startsWith('file:') || href.startsWith('custom:')) {
      assert.match(markup, /data-reason="unsafe-scheme"/, href);
      // The affordance is the `title` tooltip, not an aria-label: the span is
      // role-less, so a name on it was never announced. Asserting on title
      // keeps the guarantee that the reason reaches the user at all.
      assert.match(markup, /title="Unsafe link"/, href);
      assert.doesNotMatch(markup, /aria-label="Unsafe link"/, href);
    }
  }
});

it('never loads non-allowlisted Markdown image sources', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: [
      '![standalone](file:///Users/example/.ssh/id_rsa)',
      '',
      'caption ![inline](custom://private-resource)',
      '',
      '![reference][avatar]',
      '',
      '[avatar]: file:///Users/example/private.png',
    ].join('\n'),
  }));

  assert.doesNotMatch(markup, /<img\b/);
  assert.doesNotMatch(markup, /\bsrc="(?:file|custom):/);
});

it('does not treat navigation and communication schemes as image resources', () => {
  for (const src of [
    'maka://tool/run',
    'MAKA://auth/login',
    'maka://settings/models',
    'maka://compose?text=hello',
    'mailto:user@example.com',
  ]) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, {
      text: `![not-an-image](${src})`,
    }));

    assert.doesNotMatch(markup, /<img\b/, src);
    assert.doesNotMatch(markup, /\bsrc=/, src);
  }
});

it('keeps allowlisted images and image-like code intact', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: [
      '![safe](https://example.com/image.png)',
      '',
      'badge ![inline-safe](https://example.com/badge.png) stays inline',
      '',
      '`![literal](file:///Users/example/private.png)`',
    ].join('\n'),
  }));

  assert.equal(markup.match(/<img\b/g)?.length, 2);
  assert.match(markup, /src="https:\/\/example\.com\/image\.png"/);
  assert.match(markup, /src="https:\/\/example\.com\/badge\.png" alt="inline-safe" style="display:inline-block"/);
  assert.match(markup, /!\[literal\]\(file:\/\/\/Users\/example\/private\.png\)/);
});

it('renders GFM task lists as read-only Astryx checkboxes', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '- [x] done\n- [ ] todo',
  }));

  assert.match(markup, /<input[^>]*type="checkbox"[^>]*aria-readonly="true"[^>]*checked=""/);
  assert.match(markup, /<input[^>]*type="checkbox"[^>]*aria-readonly="true"(?![^>]*checked)/);
  assert.match(markup, />done</);
  assert.match(markup, />todo</);
});

it('localizes Astryx Markdown accessibility copy in Chinese', () => {
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'zh',
        children: createElement(
          AstryxLocaleProvider,
          null,
          createElement(MarkdownBody, {
            text: '- [x] 完成',
          }),
        ),
      },
    ),
  );

  assert.match(markup, />任务列表</);
  assert.match(markup, />复选框</);
  assert.doesNotMatch(markup, />Task list</);
  assert.doesNotMatch(markup, />Checkbox</);
});

// A dead-config guard used to sit here, banning override keys for Astryx
// surfaces Maka supposedly never rendered. Both of its entries rotted the
// same way: `chat` stopped being true at #1795 (ChatLayout took over the
// transcript, and the guard then blocked the fix for the English
// scroll-to-bottom pill), and `lightbox` was never true — chat-turn.tsx
// reaches Lightbox through useLightbox, which a JSX-tag scan misses. A ban
// list keyed to "what we render today" goes stale silently, so it is gone;
// the tests below pin the surfaces we know are live instead.
function assertChineseAstryxOverrides(keys: readonly string[]) {
  const messages = astryxMessageOverrides('zh')?.zh ?? {};
  for (const key of keys) {
    // Assert presence first: this reads the override map directly (no catalog
    // resolution), so a deleted entry yields undefined → '' — which holds no
    // Latin letters and would satisfy the translation check on its own. (At
    // runtime the same missing entry falls back to Astryx's shipped en
    // catalog, i.e. English in the UI.)
    const value = messages[key];
    assert.ok(value, `missing override: ${key}`);
    assert.doesNotMatch(
      value.replace(/\{[^}]*\}/g, ''),
      /[A-Za-z]/,
      `untranslated: ${key}`,
    );
  }
}

it('localizes the Astryx chat chrome adopted in #1795', () => {
  const messages = astryxMessageOverrides('zh')?.zh ?? {};
  assert.equal(messages['@astryx.chatLayout.newMessages'], '跳到最新消息');
  assert.equal(messages['@astryx.chatLayoutScrollButton.scrollToBottom'], '滚动到底部');
  assertChineseAstryxOverrides(['@astryx.chatToolCalls.error', '@astryx.chat.status.sent']);
});

// Whole-map sweep: every override must target a key Astryx actually ships,
// carry the same ICU arguments as the en default (a renamed placeholder
// throws at format time), and hold no Latin outside {…} segments. The pinned
// tests above cover specific regressions; this keeps the other ~70 entries
// honest without naming them one by one.
it('every zh override is a real Astryx key, translated, with matching ICU args', () => {
  const require = createRequire(import.meta.url);
  const catalog: Record<string, { defaultMessage: string }> = require(
    '@astryxdesign/core/locales/en.json',
  );
  // Top-level ICU argument names only: inside `{count, plural, one {result}}`
  // the `{result}` is branch text, not an argument — a naive regex would
  // report it and flag every zh string that drops an inapplicable plural.
  const icuArgs = (message: string) => {
    const args = new Set<string>();
    let depth = 0;
    for (let i = 0; i < message.length; i++) {
      if (message[i] === '{') {
        if (depth === 0) {
          const m = /^\{\s*([a-zA-Z0-9_]+)/.exec(message.slice(i));
          if (m?.[1]) args.add(m[1]);
        }
        depth++;
      } else if (message[i] === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
    return args;
  };
  const messages = astryxMessageOverrides('zh')?.zh ?? {};
  assert.ok(Object.keys(messages).length > 0);
  for (const [key, value] of Object.entries(messages)) {
    const shipped = catalog[key];
    assert.ok(shipped, `override targets a key Astryx does not ship: ${key}`);
    assert.ok(value, `empty override: ${key}`);
    assert.doesNotMatch(
      value.replace(/\{[^}]*\}/g, ''),
      /[A-Za-z]/,
      `untranslated: ${key} = ${value}`,
    );
    assert.deepEqual(
      icuArgs(value),
      icuArgs(shipped.defaultMessage),
      `ICU argument mismatch for ${key}: zh "${value}" vs en "${shipped.defaultMessage}"`,
    );
  }
});

it('localizes the Lightbox reached via useLightbox in chat-turn', () => {
  assertChineseAstryxOverrides([
    '@astryx.lightbox.mediaViewer',
    '@astryx.lightbox.close',
    '@astryx.lightbox.previous',
    '@astryx.lightbox.next',
  ]);
});

it('uses the localized Astryx code block and syntax tokenizer', () => {
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'zh',
        children: createElement(
          AstryxLocaleProvider,
          null,
          createElement(MarkdownBody, {
            text: ['```typescript', 'const answer = 42;', '```'].join('\n'),
          }),
        ),
      },
    ),
  );

  assert.match(markup, /aria-label="复制代码"/);
  assert.match(markup.replace(/<[^>]*>/g, ''), /const answer = 42;/);
});

it('routes settled Mermaid fences to the lazy diagram surface', () => {
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(MarkdownBody, {
          text: ['```mermaid', 'flowchart LR', 'A --> B', '```'].join('\n'),
        }),
      },
    ),
  );

  assert.match(markup, /data-maka-contract="mermaid"/);
  assert.match(markup, /data-maka-mermaid-state="loading"/);
  assert.match(markup, /Rendering Mermaid diagram/);
  assert.match(markup, /flowchart LR/);
});

it('defers Mermaid fences beyond the per-Markdown automatic diagram budget', () => {
  const fence = (index: number) => [
    '```mermaid',
    `flowchart LR\nA${index} --> B${index}`,
    '```',
  ].join('\n');
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(MarkdownBody, {
          text: Array.from(
            { length: MAX_AUTOMATIC_MERMAID_DIAGRAMS + 1 },
            (_, index) => fence(index),
          ).join('\n\n'),
        }),
      },
    ),
  );

  assert.equal(markup.match(/data-maka-mermaid-state="loading"/g)?.length, 3);
  assert.equal(markup.match(/data-maka-mermaid-state="deferred"/g)?.length, 1);
  assert.match(markup, /Render diagram/);
  assert.doesNotMatch(markup, /makamermaiddeferred/);
});

it('enforces per-diagram and total automatic Mermaid source budgets', () => {
  const oversized = ['```mermaid', 'x'.repeat(MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH + 1), '```'].join('\n');
  assert.match(
    applyMermaidRenderBudget(oversized),
    /```makamermaiddeferred/,
  );

  const nearHalfTotal = 'x'.repeat(Math.floor(MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH / 2) - 100);
  const source = [nearHalfTotal, nearHalfTotal, 'x'.repeat(250)]
    .map((code) => ['```mermaid', code, '```'].join('\n'))
    .join('\n\n');
  assert.equal(
    applyMermaidRenderBudget(source).match(/```makamermaiddeferred/g)?.length,
    1,
  );
});

it('does not render Mermaid while the assistant turn is streaming', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: ['```mermaid', 'flowchart LR', 'A --> B', '```'].join('\n'),
    streaming: true,
  }));

  assert.doesNotMatch(markup, /data-maka-contract="mermaid"/);
});

it('pins Mermaid security and complexity limits for untrusted assistant output', () => {
  const config = createMermaidConfig('dark');

  assert.equal(config.startOnLoad, false);
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.suppressErrorRendering, true);
  assert.equal(config.htmlLabels, false);
  assert.equal(config.maxTextSize, MAX_MERMAID_SOURCE_LENGTH);
  assert.equal(config.maxEdges, MAX_MERMAID_EDGES);
  assert.equal(config.theme, 'dark');
});

it('lets fullscreen Mermaid diagrams grow beyond their inline natural size', () => {
  const viewport = {
    availableWidth: 1200,
    availableHeight: 900,
    naturalWidth: 600,
    naturalHeight: 300,
  };

  assert.equal(calculateMermaidFitScale({ ...viewport, expanded: false }), 1);
  assert.equal(calculateMermaidFitScale({ ...viewport, expanded: true }), 2);
});

it('keeps a single newline as a CommonMark soft break', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '**小节标题**\n正文内容',
  }));

  assert.doesNotMatch(markup, /<br\s*\/?>/);
  assert.match(markup, /<\/strong>\n正文内容/);
});

it('renders an explicit CommonMark hard break as a native break', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '第一行  \n第二行',
  }));

  assert.match(markup, /第一行<br\s*\/?>第二行/);
});

it('keeps incomplete syntax literal after the stream settles', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Hello **world',
  }));

  assert.match(markup, /Hello \*\*world/);
});

it('does not reveal the unreached tail on the first streaming render', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'visible start and unreached tail',
    streaming: true,
  }));

  assert.doesNotMatch(markup, /unreached tail/);
});

it('keeps the lazy fallback behind the streaming display cursor', () => {
  const markup = renderToStaticMarkup(createElement(Markdown, {
    text: 'visible start and lazy unreached tail',
    streaming: true,
  }));

  assert.doesNotMatch(markup, /lazy unreached tail/);
});

it('shows the complete stream immediately in deterministic fixtures', () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: {
        dataset: { makaE2eFixture: 'true' },
      },
    },
  });

  try {
    const markup = renderToStaticMarkup(createElement(Markdown, {
      text: 'deterministic fixture answer',
      streaming: true,
    }));

    assert.match(markup, /deterministic fixture answer/);
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});

it('leaves block rhythm to the caller and defaults to document spacing', () => {
  // The transcript wants compact block spacing; the Daily Review panel, which
  // renders through the same component, wants document spacing. Hardcoding
  // `density="compact"` here gave the review transcript rhythm with document
  // heading sizes — the one combination the scoping rule in
  // styles/chat-message.css argues against.
  //
  // Asserting the SHAPE of the choice rather than Astryx's hashed atoms:
  // omitting the prop must render exactly as asking for `default`, and
  // `compact` must render differently. That survives an Astryx restyle and
  // still fails the moment the default flips back.
  const render = (density?: 'default' | 'compact') =>
    renderToStaticMarkup(createElement(MarkdownBody, {
      text: '# Title\n\nBody\n\n## Second\n\nMore',
      density,
    }));

  assert.equal(render(), render('default'));
  assert.notEqual(render(), render('compact'));
});
