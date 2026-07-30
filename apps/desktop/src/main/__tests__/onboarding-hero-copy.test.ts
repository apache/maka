/**
 * Tests for `getOnboardingHeroCopy` (PR110c).
 *
 * Locks the per-`OnboardingState.kind` copy + CTA mapping:
 *  - every variant returns a structure (or null for `ready_with_history`)
 *  - no raw `state.kind` enum identifier leaks into eyebrow / title /
 *    body / cta.label
 *  - Chinese-only copy
 *  - slug-only promise for per-connection variants (no connectionName /
 *    model list leaked)
 *  - `blocked: all_connections_unhealthy` is labeled (not a generic
 *    default), and its CTA points to `models` (the single connection home)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import type { OnboardingState } from '@maka/core';
import {
  getOnboardingHeroCopy as getLocalizedOnboardingHeroCopy,
  getOnboardingSetupSteps as getLocalizedOnboardingSetupSteps,
} from '../../renderer/onboarding-hero-copy.js';

const getOnboardingHeroCopy = (state: OnboardingState) => getLocalizedOnboardingHeroCopy(state, 'zh');
const getOnboardingSetupSteps = (state: OnboardingState) => getLocalizedOnboardingSetupSteps(state, 'zh');
import { readRendererContractCss } from './contract-css-helpers.js';

// Every OnboardingState.kind string. Any rendered field MUST NOT
// contain one of these as a substring — Chinese-only copy.
const RAW_KINDS = [
  'needs_connection',
  'needs_default_connection',
  'needs_connection_credentials',
  'needs_default_model',
  'ready_empty',
  'ready_with_history',
  'blocked',
  'all_connections_unhealthy',
] as const;

function renderedFields(copy: ReturnType<typeof getOnboardingHeroCopy>): string[] {
  if (!copy) return [];
  return [copy.eyebrow, copy.title, copy.body, copy.cta.label];
}

describe('getOnboardingHeroCopy — per-variant mapping', () => {
  it('needs_connection produces a welcome eyebrow + models CTA', () => {
    const copy = getOnboardingHeroCopy({ kind: 'needs_connection' } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.kind, 'needs_connection');
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.title, /[一-鿿]/);
  });

  it('needs_default_connection routes to settings · models', () => {
    const copy = getOnboardingHeroCopy({ kind: 'needs_default_connection' } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.body, /默认/);
  });

  it('needs_connection_credentials carries the connectionSlug but no connectionName promise', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'needs_connection_credentials',
      connectionSlug: 'anthropic-live',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.connectionSlug, 'anthropic-live');
    assert.equal(copy.cta.settingsSection, 'models');
    // PR110c slug-only promise: body must NOT include something that
    // looks like a fabricated connectionName / human label. The body
    // string from the helper itself doesn't reference the slug — the
    // hero component renders the slug via the `connectionSlug` field
    // as a `<code>`. The body MUST NOT include the literal slug to
    // avoid promising a sanitized name.
    assert.equal(
      copy.body.includes('anthropic-live'),
      false,
      'body should not embed the raw slug; component renders it as a separate <code>',
    );
    assert.match(copy.body, /等待填写 API key/);
    assert.doesNotMatch(copy.body, /缺少可用的 API key/);
  });

  it('needs_default_model carries the connectionSlug and points to models', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'needs_default_model',
      connectionSlug: 'openai-live',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.connectionSlug, 'openai-live');
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.body, /模型/);
  });

  it('ready_empty returns null (hero must NOT mount)', () => {
    // #1433: a configured user with no sessions is not an onboarding
    // case — they land on the normal empty chat with the one Composer.
    const copy = getOnboardingHeroCopy({
      kind: 'ready_empty',
      defaultConnectionSlug: 'a',
      defaultModel: 'm',
    } as OnboardingState);
    assert.equal(copy, null);
  });

  it('blocked: all_connections_unhealthy is labeled, routes to settings · models, destructive tone', () => {
    // @kenji PR110c review gate: blocked must NOT fall through a
    // generic default. The branch is labeled and routes to 模型 —
    // the single home for connection status, re-test, and re-login
    // now that the redundant account section is retired (U1).
    const copy = getOnboardingHeroCopy({
      kind: 'blocked',
      reason: 'all_connections_unhealthy',
    } as OnboardingState);
    assert.ok(copy);
    assert.equal(copy.kind, 'blocked');
    assert.equal(copy.tone, 'destructive');
    assert.equal(copy.cta.settingsSection, 'models');
    assert.match(copy.eyebrow, /等待恢复模型连接/);
    assert.match(copy.title, /没有通过验证/);
    assert.doesNotMatch(renderedFields(copy).join('\n'), /连接暂不可用|所有模型连接都不可用/);
  });

  it('ready_with_history returns null (hero must NOT mount)', () => {
    const copy = getOnboardingHeroCopy({
      kind: 'ready_with_history',
      defaultConnectionSlug: 'a',
      defaultModel: 'm',
    } as OnboardingState);
    assert.equal(copy, null);
  });
});

describe('getOnboardingHeroCopy — bilingual catalog', () => {
  const variants: OnboardingState[] = [
    { kind: 'needs_connection' },
    { kind: 'needs_default_connection' },
    { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
    { kind: 'needs_default_model', connectionSlug: 'openai-live' },
    { kind: 'blocked', reason: 'all_connections_unhealthy' },
  ];

  it('renders every onboarding state and setup step in English without CJK', () => {
    for (const state of variants) {
      const hero = getLocalizedOnboardingHeroCopy(state, 'en');
      assert.ok(hero);
      assert.doesNotMatch(renderedFields(hero).join('\n'), /[\u3400-\u9fff]/, state.kind);
      const steps = getLocalizedOnboardingSetupSteps(state, 'en');
      if (steps) assert.doesNotMatch(JSON.stringify(steps), /[\u3400-\u9fff]/, state.kind);
    }
  });

  it('keeps slugs byte-identical and never renders ready_with_history', () => {
    const state = { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' } as OnboardingState;
    assert.equal(getLocalizedOnboardingHeroCopy(state, 'en')?.connectionSlug, 'anthropic-live');
    assert.equal(
      getLocalizedOnboardingHeroCopy(
        { kind: 'ready_with_history', defaultConnectionSlug: 'a', defaultModel: 'm' } as OnboardingState,
        'en',
      ),
      null,
    );
  });

  it('uses the labeled English recovery CTA', () => {
    assert.equal(
      getLocalizedOnboardingHeroCopy({ kind: 'needs_connection' } as OnboardingState, 'en')?.cta.label,
      'Open Settings · Models',
    );
  });
});

describe('getOnboardingHeroCopy — invariants', () => {
  // Every state variant we currently render.
  const ALL_VARIANTS: OnboardingState[] = [
    { kind: 'needs_connection' },
    { kind: 'needs_default_connection' },
    { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
    { kind: 'needs_default_model', connectionSlug: 'openai-live' },
    { kind: 'blocked', reason: 'all_connections_unhealthy' },
  ];

  it('no raw state.kind / blocked.reason identifier leaks into rendered copy', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy, `${variant.kind} should produce copy`);
      for (const field of renderedFields(copy)) {
        for (const token of RAW_KINDS) {
          assert.equal(
            field.includes(token),
            false,
            `${variant.kind} rendered field "${field}" leaks raw token "${token}"`,
          );
        }
      }
    }
  });

  it('every rendered field is Chinese (no English / ASCII-only labels)', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      // Eyebrow is allowed to include uppercase Latin tags (e.g.
      // "READY · 开始对话") because the design uses it as a small
      // banner; title / body / cta.label must contain Chinese.
      for (const [name, value] of [
        ['title', copy.title],
        ['body', copy.body],
        ['cta.label', copy.cta.label],
      ] as const) {
        assert.match(value, /[一-鿿]/, `${variant.kind} ${name} should contain Chinese: "${value}"`);
      }
    }
  });

  it('CTA settingsSection is always a known SettingsSection', () => {
    // Soft sanity — the type system already enforces this, but
    // anchor the gate so a future loosening to `string` is caught.
    const knownSections = new Set([
      'general',
      'personalization',
      'theme',
      'daily-review',
      'models',
      'usage',
      'voice-models',
      'open-gateway',
      'bot-chat',
      'search',
      'network',
      'data',
      'about',
    ]);
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      assert.ok(knownSections.has(copy.cta.settingsSection), `${variant.kind} bad CTA section`);
    }
  });

  it('only blocked carries destructive tone', () => {
    for (const variant of ALL_VARIANTS) {
      const copy = getOnboardingHeroCopy(variant);
      assert.ok(copy);
      if (variant.kind === 'blocked') {
        assert.equal(copy.tone, 'destructive');
      } else {
        assert.equal(copy.tone, undefined, `${variant.kind} must not have destructive tone`);
      }
    }
  });
});

describe('getOnboardingSetupSteps — first-run AI setup guide', () => {
  it('guides completely new users through AI setup before first chat', () => {
    const steps = getOnboardingSetupSteps({ kind: 'needs_connection' } as OnboardingState);
    assert.ok(steps);
    assert.deepEqual(
      steps.map((step) => step.state),
      ['active', 'pending', 'pending'],
    );
    assert.match(steps.map((step) => step.label).join('\n'), /选择 AI 接入/);
    assert.match(steps.map((step) => step.detail).join('\n'), /API key|OAuth/);
    assert.match(steps.map((step) => step.detail).join('\n'), /测试并设默认|开始第一条对话/);
  });

  it('moves the active setup step to the exact missing AI configuration', () => {
    const cases: Array<[OnboardingState, string]> = [
      [{ kind: 'needs_default_connection' } as OnboardingState, '设为默认'],
      [
        {
          kind: 'needs_connection_credentials',
          connectionSlug: 'anthropic-live',
        } as OnboardingState,
        '补齐认证',
      ],
      [
        {
          kind: 'needs_default_model',
          connectionSlug: 'openai-live',
        } as OnboardingState,
        '选择聊天模型',
      ],
      [
        {
          kind: 'blocked',
          reason: 'all_connections_unhealthy',
        } as OnboardingState,
        '修复认证或网络',
      ],
    ];

    for (const [state, expectedActiveLabel] of cases) {
      const steps = getOnboardingSetupSteps(state);
      assert.ok(steps, `${state.kind} should expose setup steps`);
      assert.equal(steps.length, 3);
      const activeSteps = steps.filter((step) => step.state === 'active');
      assert.equal(activeSteps.length, 1, `${state.kind} should have exactly one active setup step`);
      assert.equal(activeSteps[0]?.label, expectedActiveLabel);
    }
  });

  it('does not render setup steps once setup is complete', () => {
    assert.equal(
      getOnboardingSetupSteps({
        kind: 'ready_empty',
        defaultConnectionSlug: 'a',
        defaultModel: 'm',
      } as OnboardingState),
      null,
    );
    assert.equal(
      getOnboardingSetupSteps({
        kind: 'ready_with_history',
        defaultConnectionSlug: 'a',
        defaultModel: 'm',
      } as OnboardingState),
      null,
    );
  });

  it('renderer uses the setup helper rather than a disconnected static checklist', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const styles = await readRendererContractCss();

    assert.match(hero, /import \{ getOnboardingHeroCopy, getOnboardingSetupSteps, type OnboardingSetupStep \} from '\.\/onboarding-hero-copy'/);
    assert.match(hero, /function SetupProgress\(props: \{ steps: readonly OnboardingSetupStep\[\] \}\)/);
    assert.match(hero, /aria-label=\{copy\.setupProgressLabel\}/);
    assert.match(hero, /copy\.setupStatus\[step\.state\]/);
    assert.match(hero, /getOnboardingSetupSteps\(\{ kind: 'needs_connection' \}, locale\)/);
    assert.match(hero, /setupSteps=\{getOnboardingSetupSteps\(\{ kind: 'needs_default_connection' \}, locale\)\}/);
    assert.equal((hero.match(/setupSteps=\{getOnboardingSetupSteps\(state, locale\)\}/g) ?? []).length, 3);
    assert.match(styles, /\.maka-onboarding-setup-steps\s*\{/);
    assert.match(styles, /\.maka-onboarding-setup-steps > li\[data-state="active"\]/);
    assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.maka-onboarding-setup-step-state/);
  });

  it('keeps default-connection setup recoverable after external Settings changes', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const switchBlock = hero.match(/switch \(state\.kind\) \{[\s\S]*?case 'needs_connection_credentials':/)?.[0] ?? '';
    const defaultConnectionBlock = hero.match(/function NeedsDefaultConnectionHero[\s\S]*?function NeedsConnectionCredentialsHero/)?.[0] ?? '';

    assert.match(switchBlock, /case 'needs_default_connection':[\s\S]*onRefreshConnections=\{props\.onRefreshConnections \? runRefreshConnections : undefined\}/);
    assert.match(switchBlock, /case 'needs_default_connection':[\s\S]*refreshConnectionsPending=\{refreshConnectionsPending\}/);
    assert.match(defaultConnectionBlock, /onRefreshConnections\?: \(\) => void/);
    assert.match(defaultConnectionBlock, /label: props\.refreshConnectionsPending === true \? copy\.refresh\.pending : copy\.refresh\.connection/);
    assert.match(defaultConnectionBlock, /disabled: props\.refreshConnectionsPending === true/);
    assert.match(defaultConnectionBlock, /busy: props\.refreshConnectionsPending === true/);
  });

  it('keeps the blocked hero action driven by the copy layer, not a hardcoded CTA', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');
    const blockedBlock = hero.match(/function BlockedHero[\s\S]*?function SkipButton/)?.[0] ?? '';

    assert.match(blockedBlock, /const hero = getOnboardingHeroCopy\(state, locale\)!/);
    assert.match(blockedBlock, /title=\{hero\.title\}/);
    assert.match(blockedBlock, /primaryCta=\{\{ label: hero\.cta\.label, onClick: \(\) => props\.onOpenSettings\(hero\.cta\.settingsSection\) \}\}/);
    assert.match(blockedBlock, /tone="destructive"/);
    assert.doesNotMatch(
      blockedBlock,
      /primaryCta=\{\{ label: '打开设置 · 模型', onClick: \(\) => props\.onOpenSettings\('models'\) \}\}/,
      'Blocked first-run recovery must route through hero.cta.settingsSection, not a hardcoded models CTA that bypasses the copy layer',
    );
    assert.doesNotMatch(
      blockedBlock,
      /tone="warning"/,
      'All-connections-unhealthy should keep destructive gravity in the rendered hero',
    );
  });

  it('keeps the Item row hover neutral, reserving accent for active rows', async () => {
    // The onboarding provider tiles now render through the shared `Item`
    // primitive, so the "neutral hover" contract lives in item.tsx rather
    // than a bespoke `.maka-onboarding-card` rule. A clickable Item should
    // wash with a faint foreground tint, never the brand `accent` (which in
    // this theme maps to the brand color reserved for active/selected rows).
    const item = await readFile(
      new URL('../../../../../packages/ui/src/primitives/item.tsx', import.meta.url),
      'utf8',
    );

    assert.match(item, /\[a&,button&\]:hover:bg-foreground\/4/);
    assert.doesNotMatch(
      item,
      /hover:bg-accent/,
      'Item rows should keep neutral hover chrome; semantic accent belongs to active rows',
    );
  });
});

describe('OnboardingHero structure', () => {
  it('renders first-run provider recommendations from the shared registry', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');

    assert.match(hero, /RECOMMENDED_PROVIDER_TYPES/);
    assert.match(hero, /RECOMMENDED_PROVIDER_TYPES\.map\(\(type\) =>/);
    assert.doesNotMatch(hero, /const FEATURED\s*=/, 'onboarding must not own a parallel provider list');
  });

  it('keeps first-run form controls on shared UI primitives', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');

    const heroImport = hero.match(/import \{[\s\S]*?\} from '@maka\/ui';/)?.[0] ?? '';
    for (const name of ['Button', 'Item', 'ItemContent', 'ItemMedia']) {
      assert.match(heroImport, new RegExp(`\\b${name}\\b`), `OnboardingHero must import ${name} from @maka/ui`);
    }
    // A bare `<button className=...>` is a hand-rolled control; forbid it. The
    // only raw `<button>` allowed is the polymorphic render target handed to an
    // `Item` (it carries no className — the primitive owns the styling).
    assert.doesNotMatch(hero, /<button[^>]*className=/, 'OnboardingHero actions must use the shared Button/Item primitives, not hand-styled buttons');
    assert.doesNotMatch(hero, /className="maka-button/, 'OnboardingHero must not keep legacy maka-button styling on migrated actions');
  });

  // #1433: the hero must never grow a second composer again. Everything
  // below — text input, Skill chips, mention popup, file import — belongs
  // to packages/ui/src/composer.tsx, which already owns the IME guard the
  // deleted clone had to be patched with (PR-FE-BUG-HUNT-0).
  it('carries no chat input of its own', async () => {
    const hero = await readFile(new URL('../../../src/renderer/OnboardingHero.tsx', import.meta.url), 'utf8');

    assert.doesNotMatch(hero, /<textarea\b/i, 'the setup hero must not render a text input');
    assert.doesNotMatch(hero, /\bTextarea\b/, 'the setup hero must not import the Textarea primitive');
    assert.doesNotMatch(hero, /useMentionPopup|ComposerMentionPopup/, 'Skill mention popups belong to the Composer');
    assert.doesNotMatch(hero, /useComposerSkillDraft|maka-composer-skill-chip/, 'Skill drafts belong to the Composer');
    // Was `/onQuickChatSubmit|quickChatPending/`, which stopped being able to
    // fail once #1433 deleted both identifiers repo-wide. The send path it was
    // guarding still exists — it is just spelled `sessions.create` now, and
    // the Composer and the command palette own it.
    assert.doesNotMatch(
      hero,
      /sessions\.create|expertTeam\.start/,
      'the setup hero must not own a send path — creating a session belongs to the Composer and the command palette',
    );
    assert.doesNotMatch(hero, /onDrop=|onPaste=|onImportDroppedTextFiles/, 'file import belongs to the Composer');
  });
});
