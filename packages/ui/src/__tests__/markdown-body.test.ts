import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import { MarkdownBody } from '../markdown-body.js';
import { MakaUriContext, Markdown } from '../markdown.js';
import {
  AstryxLocaleProvider,
  astryxMessageOverrides,
} from '../astryx-i18n.js';
import { LocaleProvider } from '../locale-context.js';

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
      assert.match(markup, /aria-label="Unsafe link"/, href);
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

it('ships overrides only for Astryx surfaces Maka renders', () => {
  const messages = astryxMessageOverrides('zh')?.zh ?? {};
  for (const key of Object.keys(messages)) {
    assert.doesNotMatch(
      key,
      /^@astryx\.(?:lightbox|chat)/,
      `dead Astryx locale override: ${key}`,
    );
  }
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

it('repairs or withholds incomplete Markdown syntax while streaming', () => {
  const emphasis = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Hello **world',
    streaming: true,
  }));
  const link = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Hello [unfinished',
    streaming: true,
  }));
  const settled = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Hello **world',
  }));

  assert.match(emphasis, /Hello <strong[^>]*>world<\/strong>/);
  assert.doesNotMatch(link, /unfinished/);
  assert.match(settled, /Hello \*\*world/);
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
