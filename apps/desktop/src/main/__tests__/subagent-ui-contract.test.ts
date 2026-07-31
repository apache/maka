import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider, OverlayHost } from '@maka/ui';

describe('subagent UI contract', () => {
  it('renders a compact subagent card without exposing internal ids', () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(OverlayHost, {
        content: {
          kind: 'subagent',
          agentName: 'Research Agent',
          turnId: 'turn-secret-123',
          runId: 'run-secret-456',
          status: 'completed',
          permissionMode: 'explore',
          summary: 'Mapped the runtime path.',
          artifactIds: ['artifact-secret-1', 'artifact-secret-2'],
          durationMs: 14_500,
          eventCount: 42,
        },
        onClose: () => {},
      }),
    }));

    assert.match(markup, /data-kind="subagent"/);
    assert.match(markup, /aria-label="关闭预览"/);
    // #1565 PR 3: Astryx Button renders the visible label inside a styled span.
    assert.match(markup, />关闭<\/span>/);
    assert.match(markup, /Research Agent/);
    assert.match(markup, /已完成/);
    assert.match(markup, /只读/);
    assert.match(markup, /耗时/);
    assert.match(markup, /Mapped the runtime path\./);
    assert.match(markup, /产物/);
    assert.match(markup, /2 个/);

    assert.doesNotMatch(markup, /turn-secret-123/);
    assert.doesNotMatch(markup, /run-secret-456/);
    assert.doesNotMatch(markup, /artifact-secret-1/);
    assert.doesNotMatch(markup, /artifact-secret-2/);
    assert.doesNotMatch(markup, />Close</);
    assert.doesNotMatch(markup, />explore</);
    assert.doesNotMatch(markup, /事件/);
    assert.doesNotMatch(markup, /42 个事件/);
  });

  it('keeps the overlay close action icon-backed and localized', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const source = await readFile(resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'tool-activity.tsx'), 'utf8');
    const block = source.match(/export function OverlayHost[\s\S]*?^}/m)?.[0] ?? '';

    assert.match(block, /<UiButton[\s\S]*className=\{previewVariants\(\{ part: 'close' \}\)\}[\s\S]*variant="ghost"[\s\S]*size="sm"/);
    assert.match(block, /aria-label=\{copy\.closeAriaLabel\}/);
    // Icon stroke governance round: per-call-site strokeWidth props were
    // deleted so lucide glyphs ride one governed weight (svg.lucide CSS rule).
    assert.match(block, /<X size=\{14\} aria-hidden="true" \/>/);
    // #1565 PR 3: Astryx Button takes the visible text as a `label` prop.
    assert.match(block, /label=\{copy\.close\}/);
    assert.doesNotMatch(block, />Close</);
  });
});
