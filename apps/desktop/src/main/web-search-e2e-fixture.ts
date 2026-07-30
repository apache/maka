import type { WebSearchResultRow } from '@maka/core';

/**
 * #1364 review follow-up: typed web-search results for the `settings-search`
 * e2e fixture.
 *
 * The Web Search page's containment contract is about the rendered result
 * list — a bare-URL title, a long proportional title, and a long snippet are
 * the widths that used to drag the whole page into horizontal overflow at the
 * 480px window floor. A real Tavily round-trip cannot exercise that: e2e runs
 * offline (CI has no key and no network), so without this fixture the test
 * would stop at the no-key message and the result CSS could regress silently.
 *
 * Mirrors `webSearchLiveResults` in `stories/settings/settings-pages.stories.tsx`
 * so the story baseline and the E2E contract describe the same page. The
 * `settings-search` scenario also seeds a configured Tavily key (see
 * `e2e-fixture/scenarios-settings.ts`) so the query controls are enabled.
 *
 * Production is untouched: this returns null unless the fixture scenario is
 * active, and the IPC handler falls through to the real `queryTavily`.
 */
const FIXTURE_SCENARIO = 'settings-search';

export function webSearchResultsE2eFixture(): WebSearchResultRow[] | null {
  if (process.env.MAKA_E2E_FIXTURE !== FIXTURE_SCENARIO) return null;
  return [
    {
      provider: 'tavily',
      title:
        'Electron 窗口在 macOS Sequoia 上 vibrancy 失效的完整排查记录：从 NSVisualEffectView 到 CSS backdrop-filter 的九层封装',
      url: 'https://blog.example-engineering-weekly.com/posts/2026/07/electron-vibrancy-regression-macos-sequoia-troubleshooting-notes-part-three',
      snippet:
        '本文覆盖 vibrancy 在 Sequoia 15.4 上的三类失效场景：窗口层级变化后 material 不再刷新、data-vibrancy 属性与 CSS 级联的竞态、以及 transparent 窗口在外接显示器上的合成器回退。附带最小复现仓库与九个已验证的 workaround，其中第七个（延迟一帧重设 backgroundColor）对 Electron 33 仍然有效。',
      source: 'blog.example-engineering-weekly.com',
    },
    {
      provider: 'tavily',
      title: 'Tavily API rate limits',
      url: 'https://docs.tavily.com/rate-limits',
      snippet: 'Standard plans allow 100 requests per minute.',
      source: 'docs.tavily.com',
    },
    {
      provider: 'tavily',
      title:
        'https://raw.githubusercontent.com/example/monorepo/refs/heads/main/packages/runtime/ARCHITECTURE.md',
      url: 'https://raw.githubusercontent.com/example/monorepo/refs/heads/main/packages/runtime/ARCHITECTURE.md',
      snippet: 'Runtime architecture notes.',
      source: 'raw.githubusercontent.com',
    },
  ];
}
