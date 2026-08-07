import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import type {
  AppSettings,
  ArtifactRecord,
  BotChannelSettings,
  OnboardingState,
  UsageStats,
} from '@maka/core';
import { build } from 'esbuild';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const LUCIDE_REACT_PACKAGE = ['lucide', 'react'].join('-');

type RendererComponents = {
  AppearanceSettingsPage(props: {
    themePref: 'light' | 'dark' | 'auto';
    themePalette: 'default';
    onUpdate(): Promise<never>;
    onThemeChange(): void;
    onThemePaletteChange(): void;
  }): ReactNode;
  ArtifactPreview(props: { record: ArtifactRecord }): ReactNode;
  PersonalizationSettingsSection(props: {
    settings: AppSettings;
    onUpdate(): Promise<never>;
  }): ReactNode;
  BotWeChatFields(props: {
    channel: BotChannelSettings;
    updateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
  }): ReactNode;
  KeyboardHelpModal(props: { isOpen: boolean; onOpenChange(isOpen: boolean): void }): ReactNode;
  LocaleProvider(props: { locale: 'zh'; children: ReactNode }): ReactNode;
  OnboardingHero(props: {
    state: OnboardingState;
    onOpenSettings(): void;
    onOpenConnectionDetail(connectionSlug: string): void;
    onAddProvider(): void;
    onBrowseProviders(): void;
  }): ReactNode;
  ProviderCatalogPage(props: {
    filter: { query: string; category: 'recommended' };
    onFilterChange(filter: { query: string; category: 'recommended' }): void;
    onPick(): void;
  }): ReactNode;
  ToastProvider(props: { children: ReactNode }): ReactNode;
  UsageSettingsPage(props: {
    settings: AppSettings;
    stats: UsageStats;
    onUpdate(): Promise<never>;
    onReload(): Promise<void>;
  }): ReactNode;
};

function renderWithLocale(
  LocaleProvider: RendererComponents['LocaleProvider'],
  child: ReactNode,
  ToastProvider?: RendererComponents['ToastProvider'],
): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: ToastProvider ? createElement(ToastProvider, { children: child }) : child,
    }),
  );
}

const rendererComponents = importRendererComponents();

describe('Astryx component behavior', () => {
  it('announces artifact loading exactly once', async () => {
    const { ArtifactPreview, LocaleProvider } = await rendererComponents;
    const record: ArtifactRecord = {
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      createdAt: 1,
      name: 'notes.txt',
      kind: 'file',
      relativePath: 'notes.txt',
      sizeBytes: 12,
      status: 'live',
    };
    const markup = renderWithLocale(LocaleProvider, createElement(ArtifactPreview, { record }));

    assert.equal(markup.match(/role="status"/g)?.length, 1);
    assert.match(markup, /加载文件预览…/);
  });

  it('gives keyboard glyphs spoken Astryx key names', async () => {
    const { KeyboardHelpModal, LocaleProvider } = await rendererComponents;
    const markup = renderWithLocale(LocaleProvider, createElement(KeyboardHelpModal, {
      isOpen: true,
      onOpenChange: () => undefined,
    }));

    assert.match(markup, /aria-label="Up arrow"/);
    assert.match(markup, /aria-label="Down arrow"/);
    assert.match(markup, /aria-label="Left arrow"/);
    assert.match(markup, /aria-label="Right arrow"/);
    assert.match(markup, /aria-label="Control"/);
    assert.doesNotMatch(markup, /aria-label="(?:↑|↓|←|→|⌘)"/);
  });

  it('uses native button semantics for onboarding provider items', async () => {
    const { LocaleProvider, OnboardingHero } = await rendererComponents;
    const markup = renderWithLocale(LocaleProvider, createElement(OnboardingHero, {
      state: { kind: 'needs_connection' },
      onOpenSettings: () => undefined,
      onOpenConnectionDetail: () => undefined,
      onAddProvider: () => undefined,
      onBrowseProviders: () => undefined,
    }));

    assert.match(
      markup,
      /data-provider="opencode-free"[^>]*>[\s\S]*?<button type="button"[^>]*>[\s\S]*?OpenCode Zen[\s\S]*?<\/button>/,
    );
    assert.equal(markup.match(/<li[^>]*data-provider=/g)?.length, 4);
  });

  it('shows the product-recommended providers first during onboarding', async () => {
    const { LocaleProvider, OnboardingHero } = await rendererComponents;
    const markup = renderWithLocale(LocaleProvider, createElement(OnboardingHero, {
      state: { kind: 'needs_connection' },
      onOpenSettings: () => undefined,
      onOpenConnectionDetail: () => undefined,
      onAddProvider: () => undefined,
      onBrowseProviders: () => undefined,
    }));

    const providerTypes = [...markup.matchAll(/<li[^>]*data-provider="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(providerTypes, ['opencode-free', 'opencode-go', 'openai', 'anthropic']);
  });

  it('shows the current connection recovery without a progress checklist', async () => {
    const { LocaleProvider, OnboardingHero } = await rendererComponents;
    const markup = renderWithLocale(LocaleProvider, createElement(OnboardingHero, {
      state: { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
      onOpenSettings: () => undefined,
      onOpenConnectionDetail: () => undefined,
      onAddProvider: () => undefined,
      onBrowseProviders: () => undefined,
    }));

    assert.match(markup, /data-maka-contract="onboarding-card"/);
    assert.match(markup, /<button[^>]*data-connection-slug="anthropic-live"/);
    assert.doesNotMatch(markup, /配置 AI 进度|当前步骤|待完成/);
  });

  it('keeps routine provider metadata out of badges', async () => {
    const { LocaleProvider, ProviderCatalogPage } = await rendererComponents;
    const markup = renderWithLocale(LocaleProvider, createElement(ProviderCatalogPage, {
      filter: { query: '', category: 'recommended' },
      onFilterChange: () => undefined,
      onPick: () => undefined,
    }));

    assert.match(markup, /data-maka-contract="provider-catalog"/);
    assert.doesNotMatch(markup, /astryx-badge/);
  });

  it('opens WeChat advanced settings only when advanced values already exist', async () => {
    const { BotWeChatFields, LocaleProvider, ToastProvider } = await rendererComponents;
    const channel: BotChannelSettings = {
      provider: 'wechat',
      enabled: false,
      connected: false,
      readiness: 'unscaffolded',
      token: '',
      proxyUrl: '',
    };
    const renderFields = (next: BotChannelSettings) => renderWithLocale(
      LocaleProvider,
      createElement(BotWeChatFields, {
        channel: next,
        updateChannel: async () => true,
      }),
      ToastProvider,
    );

    assert.match(renderFields(channel), /aria-expanded="false"/);
    assert.match(renderFields({ ...channel, appId: 'existing-app' }), /aria-expanded="true"/);
  });

  it('composes Usage from the settings page kit and Astryx data surface', async () => {
    const { LocaleProvider, ToastProvider, UsageSettingsPage } = await rendererComponents;
    const settings = {
      usage: {
        range: '7d',
        status: 'all',
        modelFilter: '',
        showDetails: false,
        activeTab: 'providers',
      },
    } as AppSettings;
    const stats: UsageStats = {
      summary: {
        totalRequests: 1,
        totalCostUsd: 0,
        totalTokens: 1,
        inputTokens: 1,
        outputTokens: 0,
        cacheTokens: 0,
        cacheMiss: 0,
        cacheRead: 0,
        cacheCreation: 0,
        reasoning: 0,
      },
      logs: [],
      byProvider: [{ provider: 'OpenAI', requests: 1, tokens: 1, costUsd: 0 }],
      byModel: [],
      byTool: [],
      pricing: [],
    };
    const markup = renderWithLocale(
      LocaleProvider,
      createElement(UsageSettingsPage, {
        settings,
        stats,
        onUpdate: async () => { throw new Error('not called during render'); },
        onReload: async () => undefined,
      }),
      ToastProvider,
    );

    assert.match(markup, /class="[^"]*settingsPageStack[^"]*settingsUsagePage/);
    assert.match(markup, /class="astryx-card[^"]*settingsUsageTable/);
    assert.match(markup, /class="astryx-table-scroll-wrapper/);
    assert.equal(markup.match(/<td\b[^>]*role="rowheader"/g)?.length, 1);
  });

  it('files every appearance option tile under a named group', async () => {
    const { AppearanceSettingsPage, LocaleProvider, ToastProvider } = await rendererComponents;
    const markup = renderWithLocale(
      LocaleProvider,
      createElement(AppearanceSettingsPage, {
        themePref: 'auto',
        themePalette: 'default',
        onUpdate: async () => { throw new Error('not called during render'); },
        onThemeChange: () => undefined,
        onThemePaletteChange: () => undefined,
      }),
      ToastProvider,
    );

    // One page root. The page used to wrap a second component that opened a
    // `SettingsPage` of its own, so the page grid nested inside itself.
    assert.equal(markup.match(/class="[^"]*settingsPageStack/g)?.length, 1);

    // Each `<section>` is named by its own heading, and each option grid is a
    // group named by the label the user can see above it — 主题 for the theme
    // tiles, 编辑器主题 / 产品色调 for the two palette sets. Without this the
    // page hands assistive tech 14 loose tiles with no statement of which set
    // any of them belongs to.
    for (const id of [
      'settings-appearance-theme-heading',
      'settings-appearance-palette-heading',
      'settings-appearance-palette-editor-label',
      'settings-appearance-palette-product-label',
    ]) {
      assert.match(markup, new RegExp(`id="${id}"`), `missing anchor id ${id}`);
      assert.match(markup, new RegExp(`aria-labelledby="${id}"`), `nothing points at ${id}`);
    }
    assert.equal(markup.match(/role="group"/g)?.length, 3);
    assert.equal(markup.match(/<section [^>]*aria-labelledby=/g)?.length, 2);

    // 界面语言 lives on 通用 now; the 外观 page must not grow it back.
    assert.doesNotMatch(markup, /界面语言/);
  });

  it('keeps the identity block a section of 通用, not a page of its own', async () => {
    const { LocaleProvider, PersonalizationSettingsSection, ToastProvider } = await rendererComponents;
    const settings = {
      personalization: { displayName: '', assistantTone: '', uiLocale: 'zh' },
    } as AppSettings;
    const markup = renderWithLocale(
      LocaleProvider,
      createElement(PersonalizationSettingsSection, {
        settings,
        onUpdate: async () => { throw new Error('not called during render'); },
      }),
      ToastProvider,
    );

    // 通用 renders this inside its own page stack; a second one here nests the
    // page grid in itself and doubles the section rhythm.
    assert.doesNotMatch(markup, /settingsPageStack/);
    assert.match(markup, /class="settingsSection"/);
  });
});

async function importRendererComponents(): Promise<RendererComponents> {
  const outfile = resolve(
    REPO_ROOT,
    'apps/desktop/dist/main/__tests__/astryx-component-behavior.bundle.mjs',
  );
  await build({
    stdin: {
      contents: [
        "export { AppearanceSettingsPage } from './apps/desktop/src/renderer/settings/appearance-settings-page.tsx';",
        "export { ArtifactPreview } from './apps/desktop/src/renderer/artifact-preview.tsx';",
        "export { BotWeChatFields } from './apps/desktop/src/renderer/settings/bot-wechat-login.tsx';",
        "export { KeyboardHelpModal } from './apps/desktop/src/renderer/keyboard-help.tsx';",
        "export { OnboardingHero } from './apps/desktop/src/renderer/onboarding-hero.tsx';",
        "export { PersonalizationSettingsSection } from './apps/desktop/src/renderer/settings/personalization-settings-section.tsx';",
        "export { ProviderCatalogPage } from './apps/desktop/src/renderer/settings/provider-catalog-page.tsx';",
        "export { UsageSettingsPage } from './apps/desktop/src/renderer/settings/usage-settings-page.tsx';",
        "export { LocaleProvider } from './packages/ui/dist/locale-context.js';",
        "export { ToastProvider } from './packages/ui/dist/toast.js';",
      ].join('\n'),
      resolveDir: REPO_ROOT,
      sourcefile: 'astryx-component-behavior.entry.mjs',
    },
    outfile,
    bundle: true,
    external: [
      '@maka/core',
      LUCIDE_REACT_PACKAGE,
      'react',
      'react-dom',
      'react-dom/*',
      'react/jsx-runtime',
    ],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl' },
    logLevel: 'silent',
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as RendererComponents;
}
