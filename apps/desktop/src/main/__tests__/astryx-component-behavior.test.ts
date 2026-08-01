import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import type { ArtifactRecord, BotChannelSettings, OnboardingState } from '@maka/core';
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

describe('Astryx component behavior', () => {
  it('announces artifact loading exactly once', async () => {
    const { ArtifactPreview, LocaleProvider } = await importRendererComponents();
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
    const { KeyboardHelpModal, LocaleProvider } = await importRendererComponents();
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
    const { LocaleProvider, OnboardingHero } = await importRendererComponents();
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
    const { BotWeChatFields, LocaleProvider, ToastProvider } = await importRendererComponents();
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
