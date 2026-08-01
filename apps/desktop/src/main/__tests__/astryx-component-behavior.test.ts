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
  ArtifactPreview(props: { record: ArtifactRecord }): ReactNode;
  BotWeChatFields(props: {
    channel: BotChannelSettings;
    updateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
  }): ReactNode;
  KeyboardHelpModal(props: { isOpen: boolean; onOpenChange(isOpen: boolean): void }): ReactNode;
  LocaleProvider(props: { locale: 'zh'; children: ReactNode }): ReactNode;
  OnboardingHero(props: {
    state: OnboardingState;
    onOpenSettings(): void;
    onAddProvider(): void;
    onBrowseProviders(): void;
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
      onAddProvider: () => undefined,
      onBrowseProviders: () => undefined,
    }));

    assert.match(
      markup,
      /maka-firstrun-row[^>]*>[\s\S]*?<button type="button"[^>]*>[\s\S]*?OpenCode Zen[\s\S]*?<\/button>/,
    );
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

  it('exposes the first usage cell in each body row as its row header', async () => {
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

    assert.equal(markup.match(/<td\b[^>]*role="rowheader"/g)?.length, 1);
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
        "export { ArtifactPreview } from './apps/desktop/src/renderer/artifact-preview.tsx';",
        "export { BotWeChatFields } from './apps/desktop/src/renderer/settings/bot-wechat-login.tsx';",
        "export { KeyboardHelpModal } from './apps/desktop/src/renderer/keyboard-help.tsx';",
        "export { OnboardingHero } from './apps/desktop/src/renderer/OnboardingHero.tsx';",
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
