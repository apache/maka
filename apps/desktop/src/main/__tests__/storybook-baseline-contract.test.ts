import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT } from './main-process-contract-source-helpers.js';

/**
 * The rule these assertions enforce is "do not import the app shell", so match
 * the import specifier rather than the bare name — #1433 item 6 added prose
 * comments that cite `app-shell.tsx` as the file a story's real path runs
 * through, and naming a file is not depending on it.
 *
 * Anchored to the module itself, not to any specifier containing the string:
 * `app-shell-command-actions` is a leaf a story may legitimately import (the
 * command-list builder would make command-search.stories.tsx MORE faithful,
 * not less), and this rule is about the shell component.
 */
const IMPORTS_APP_SHELL = /from\s+['"][^'"]*app-shell(?:\.js)?['"]/;

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

function readTypescriptConfig(repoRoot: string, configPath: string) {
  const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
  const tscBin = join(dirname(requireFromRepo.resolve('typescript/package.json')), 'bin', 'tsc');
  return JSON.parse(execFileSync(
    process.execPath,
    [tscBin, '-p', configPath, '--showConfig'],
    { encoding: 'utf8' },
  )) as { files?: string[] };
}

describe('Storybook baseline contract', () => {
  it('keeps Storybook as renderer tooling, not part of mandatory build, test, or CI', () => {
    const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
    const desktopPkg = readJson(join(REPO_ROOT, 'apps', 'desktop', 'package.json'));
    const desktopScripts = desktopPkg.scripts ?? {};
    const ciWorkflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    assert.match(desktopScripts.storybook ?? '', /storybook dev\b/);
    assert.match(desktopScripts['build-storybook'] ?? '', /storybook build\b/);

    for (const [name, script] of Object.entries({
      'root build': rootPkg.scripts?.build ?? '',
      'root test': rootPkg.scripts?.test ?? '',
      'desktop build': desktopScripts.build ?? '',
      'desktop test': desktopScripts.test ?? '',
    })) {
      assert.doesNotMatch(script, /storybook/i, `${name} must not run Storybook yet`);
    }

    assert.doesNotMatch(
      ciWorkflow,
      /\bstorybook-smoke:|build-storybook|smoke:storybook/,
      'default CI must keep the Product Storybook smoke opt-in',
    );
  });

  it('uses the renderer Vite/CSS setup so stories render against the app substrate', () => {
    const storybookDir = join(REPO_ROOT, 'apps', 'desktop', '.storybook');
    const mainPath = join(storybookDir, 'main.ts');
    const previewPath = join(storybookDir, 'preview.tsx');

    assert.ok(existsSync(mainPath), 'desktop Storybook must define .storybook/main.ts');
    assert.ok(existsSync(previewPath), 'desktop Storybook must define .storybook/preview.tsx');

    const main = readFileSync(mainPath, 'utf8');
    const preview = readFileSync(previewPath, 'utf8');

    assert.match(main, /framework:\s*\{\s*name:\s*['"]@storybook\/react-vite['"]/);
    assert.match(main, /@maka\/ui/);
    assert.match(main, /packages\/ui\/src/);
    assert.match(preview, /\.\.\/src\/renderer\/styles\.css/);
    assert.match(preview, /data-maka-theme/);
  });

  it('keeps Product stories free of implicit global geometry', () => {
    const preview = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'preview.tsx'), 'utf8');

    assert.match(preview, /context\.title\.startsWith\(['"]Product\/['"]\)/);
    assert.match(preview, /if\s*\([^)]*Product/);
    assert.match(preview, /return\s+<LocaleProvider[^>]*><Story\s*\/><\/LocaleProvider>/);
    assert.match(preview, /p-6/, 'non-Product stories must retain explicit review padding');
  });

  it('uses production-owned hosts for the four module baselines', () => {
    const storyPath = join(REPO_ROOT, 'apps', 'desktop', 'stories', 'module-hubs.stories.tsx');
    const story = readFileSync(storyPath, 'utf8');

    assert.match(story, /AppShellDetailPanel/);
    assert.match(story, /AppShellWorkspaceTopActions/);
    assert.doesNotMatch(
      story,
      /<AppShellDetailPanel[^>]*style=/,
      'the story scaffold, not the production panel, must own iframe geometry',
    );
    for (const storyName of [
      'ExtensionsSkills',
      'ExtensionsMcp',
      'ScheduledPlanReminders',
      'ScheduledDailyReview',
      'ExtensionsSkillsInstalled',
      'ScheduledPlanRemindersConfigured',
      'ScheduledDailyReviewLoading',
      'ScheduledDailyReviewLoadError',
    ]) {
      assert.match(story, new RegExp(`export const ${storyName}: Story`));
    }
    assert.doesNotMatch(
      story,
      /className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"/,
      'stories must consume the production detail-panel host instead of copying its class chain',
    );
    for (const callback of [
      'onRefreshSkills',
      'onCreateSkillTemplate',
      'onOpenSkill',
      'onOpenSkillsFolder',
      'onRefresh',
      'onCreate',
      'onUpdate',
      'onToggle',
      'onTriggerNow',
      'onSnooze',
      'onClearRunHistory',
      'onDelete',
    ]) {
      assert.match(story, new RegExp(`${callback}=\\{noop\\}`), `${callback} must remain visible`);
    }
    assert.match(story, /status:\s*'paused'/, 'configured reminders must preserve paused-state coverage');
    assert.match(story, /status:\s*'completed'/, 'configured reminders must preserve completed-state coverage');

    for (const obsoleteStory of [
      'skills-panel.stories.tsx',
      'plan-reminder-panel.stories.tsx',
      'daily-review-panel.stories.tsx',
    ]) {
      assert.equal(
        existsSync(join(REPO_ROOT, 'packages', 'ui', 'stories', obsoleteStory)),
        false,
        `${obsoleteStory} must not remain as a parallel inner-panel baseline`,
      );
    }
  });

  it('offers only real Maka theme palettes in the Storybook toolbar', () => {
    const preview = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'preview.tsx'), 'utf8');
    const settings = readFileSync(join(REPO_ROOT, 'packages', 'core', 'src', 'settings.ts'), 'utf8');
    const paletteSource = settings.match(/export const THEME_PALETTES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
    const allowed = [...paletteSource.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    assert.ok(allowed.length > 0, '@maka/core must define THEME_PALETTES');
    assert.match(
      preview,
      /import\s+\{[^}]*THEME_PALETTES[^}]*\}\s+from\s+['"][^'"]*settings/,
      'preview.tsx must import THEME_PALETTES so the toolbar stays single-sourced',
    );
    assert.match(
      preview,
      /items:\s*THEME_PALETTES\.map/,
      'preview.tsx must generate toolbar items from THEME_PALETTES',
    );
  });

  it('seeds primitive stories as the isolation acceptance fixture', () => {
    const storiesDir = join(REPO_ROOT, 'packages', 'ui', 'stories');
    const buttonStory = join(storiesDir, 'button.stories.tsx');
    const emptyStory = join(storiesDir, 'empty.stories.tsx');
    assert.ok(existsSync(buttonStory), 'Button primitive story must exist as an isolation fixture');
    assert.ok(existsSync(emptyStory), 'Empty primitive story must exist as an isolation fixture');

    const buttonSrc = readFileSync(buttonStory, 'utf8');
    assert.match(buttonSrc, /satisfies\s+Meta/, 'button.stories.tsx must use satisfies Meta');
    for (const exportName of ['VariantMatrix', 'SizeMatrix', 'WithIcon', 'Loading']) {
      assert.match(buttonSrc, new RegExp(`export const ${exportName}: Story`), `button.stories.tsx must export ${exportName}`);
    }

    const emptySrc = readFileSync(emptyStory, 'utf8');
    assert.match(emptySrc, /satisfies\s+Meta/, 'empty.stories.tsx must use satisfies Meta');
    for (const exportName of ['IconOnly', 'TitleAndDescription', 'WithAction', 'Loading']) {
      assert.match(emptySrc, new RegExp(`export const ${exportName}: Story`), `empty.stories.tsx must export ${exportName}`);
    }
    assert.match(emptySrc, /\bSpinner\b/, 'empty.stories.tsx Loading story must cover Spinner');
  });

  it('curated primitive components appear in story source', () => {
    const storiesDir = join(REPO_ROOT, 'packages', 'ui', 'stories');
    const storyFiles = readdirSync(storiesDir).filter((f) => f.endsWith('.stories.tsx'));
    const allStorySrc = storyFiles.map((f) => readFileSync(join(storiesDir, f), 'utf8')).join('\n');

    const curatedPrimitives = [
      'Button', 'Badge', 'Input', 'Textarea', 'Separator', 'Checkbox',
      'DialogRoot', 'TabsRoot', 'SelectRoot', 'Label', 'Switch', 'Toggle', 'ToggleGroup',
      'RadioGroup', 'Radio', 'Progress', 'Alert', 'Empty', 'Spinner', 'Kbd',
      'Menu', 'Accordion', 'Toolbar', 'ToastProvider',
    ];
    const missing = curatedPrimitives.filter(
      (name) => !new RegExp(`<${name}[\\s/>]`).test(allStorySrc),
    );
    assert.deepEqual(
      missing,
      [],
      `Curated primitive components not found in story source: ${missing.join(', ')}. ` +
        'This is a textual smoke check, not an exhaustive export or JSX AST check; ' +
        'typecheck:stories is the primary drift guard for prop/type changes.',
    );
  });

  it('storyboards the sidebar session list states before visual polish', () => {
    const sidebarStories = join(REPO_ROOT, 'packages', 'ui', 'stories', 'session-list-panel.stories.tsx');
    assert.ok(existsSync(sidebarStories), 'Sidebar session-list states must be inspectable in Storybook');

    const src = readFileSync(sidebarStories, 'utf8');
    assert.match(src, /title:\s*['"]Product\/Sidebar Session List['"]/);
    assert.match(src, /SessionListPanel/);
    assert.match(src, /satisfies\s+Meta/);
    for (const storyName of [
      'Empty',
      'LongList',
      'ConversationStates',
      'RowActions',
      'LongTitlesAndNarrow',
    ]) {
      assert.match(src, new RegExp(`export const ${storyName}\\b`));
    }
    assert.doesNotMatch(src, /StatusGroups|statusGroups/);
    assert.doesNotMatch(src, IMPORTS_APP_SHELL, 'Sidebar stories must not import the desktop app shell.');

    const appShellStories = join(REPO_ROOT, 'apps', 'desktop', 'stories', 'app-shell.stories.tsx');
    const appShellSource = readFileSync(appShellStories, 'utf8');
    assert.match(appShellSource, /export const CollapsedSidebar\b/);
    assert.match(appShellSource, /export const SidebarMotion\b/);
  });

  it('storyboards ToolActivity result variants before visual polish', () => {
    const storyPath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'tool-activity.stories.tsx');
    const fixturePath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'tool-activity.fixtures.ts');
    assert.ok(existsSync(storyPath), 'ToolActivity must have a surface-scoped Storybook storyboard');
    assert.ok(existsSync(fixturePath), 'ToolActivity stories must keep dense fixture data in a sibling fixture file');

    const story = readFileSync(storyPath, 'utf8');
    const fixtures = readFileSync(fixturePath, 'utf8');

    assert.match(story, /title:\s*'Product\/Tool Activity'/);
    assert.match(story, /satisfies\s+Meta/);
    assert.match(story, /\bToolActivity\b/);

    for (const exportName of [
      'StatusOverview',
      'TerminalAndLiveOutput',
      'FileDiffAndWebSearch',
      'SubagentAndExplore',
      'OfficeDocument',
      'ErrorsAndPermissionDenied',
      'CopyFeedback',
      'DenseMixedResults',
    ]) {
      assert.match(story, new RegExp(`export const ${exportName}: Story`), `${exportName} story must be exported`);
    }

    for (const requiredKind of [
      'terminal',
      'file_diff',
      'web_search',
      'web_search_error',
      'subagent',
      'explore_agent',
      'office_document',
    ]) {
      assert.match(fixtures, new RegExp(`kind:\\s*'${requiredKind}'`), `${requiredKind} fixture must exist`);
    }

    assert.match(fixtures, /outputTruncated:\s*true/, 'stories must cover live-output truncation');
    assert.match(fixtures, /User denied permission/, 'stories must cover permission-denied copy');
    assert.match(story, /expandAll/, 'result preview stories must expose collapsed successful previews for visual review');
    assert.match(story, /autoCopyLabel/, 'stories must expose copy feedback rather than only idle copy buttons');
  });

  it('labels the retained functional motion examples', () => {
    const story = readFileSync(join(REPO_ROOT, 'packages', 'ui', 'stories', 'animation-catalog.stories.tsx'), 'utf8');

    assert.match(story, /title:\s*'Design System\/Animation Catalog'/);
    for (const label of ['Spinner', 'Shimmer']) {
      assert.match(story, new RegExp(`>\\s*${label}\\s*<`), `${label} must be visible beside its motion sample`);
    }
  });

  it('tracks every icon export in the Design System Icons story', () => {
    const storyPath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'icons.stories.tsx');
    assert.ok(existsSync(storyPath), 'Design System must include an Icons story');

    const story = readFileSync(storyPath, 'utf8');
    assert.match(story, /title:\s*['"]Design System\/Icons['"]/);
    assert.match(story, /import\s+\*\s+as\s+Icons\s+from\s+['"]\.\.\/src\/icons\.js['"]/);
    assert.match(story, /export const LucideIcons: Story/);
    assert.match(story, /lucide-react re-export/, 'Icons story must explain the Lucide runtime seam');
    assert.match(story, /OMITTED_RUNTIME_EXPORTS/);
    assert.match(story, /BotBrandLogo/);
    assert.match(story, /BOT_BRAND/);
    for (const provider of ['telegram', 'feishu', 'wecom', 'wechat', 'discord', 'dingtalk', 'qq', 'slack', 'whatsapp']) {
      assert.match(story, new RegExp(`['"]${provider}['"]`), `${provider} must appear in the bot brand icon story`);
    }
  });

  it('removes the temporary Phosphor vs Lucide icon comparison story after the Lucide cutover', () => {
    const storyPath = join(REPO_ROOT, 'packages', 'ui', 'stories', 'icon-set-comparison.stories.tsx');
    assert.ok(!existsSync(storyPath), 'temporary side-by-side icon comparison story must not ship after cutover');
  });

  it('splits design token examples into focused stories', () => {
    const story = readFileSync(join(REPO_ROOT, 'packages', 'ui', 'stories', 'design-tokens.stories.tsx'), 'utf8');

    assert.match(story, /title:\s*'Design System\/Tokens'/);
    for (const exportName of ['Colors', 'Radius', 'PrimaryActions', 'SemanticColors']) {
      assert.match(story, new RegExp(`export const ${exportName}: Story`), `${exportName} story must be exported`);
    }
    assert.doesNotMatch(story, /export const TokenOverview/);

    const colorSwatches = story.slice(
      story.indexOf('const colorSwatches'),
      story.indexOf('const emphasisAliases'),
    );
    assert.match(colorSwatches, /'--action'/);
    assert.match(colorSwatches, /'--control'/);
    for (const noisyToken of ['--foreground-5', '--foreground-30', '--foreground-50', '--foreground-70', '--link', '--focus-ring', '--status-running', '--nav-active', '--toast-accent']) {
      assert.doesNotMatch(colorSwatches, new RegExp(noisyToken), `${noisyToken} should not render as a separate color swatch`);
    }
  });

  it('exposes the full Design System foundation story surface', () => {
    const expected: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ['Design System/Animation Catalog', 'animation-catalog.stories.tsx', ['RetainedFunctionalMotion', 'DurationScale', 'EasingScale']],
      ['Design System/Icons', 'icons.stories.tsx', ['LucideIcons', 'BotBrandIcons']],
      ['Design System/Palette Matrix', 'palette-matrix.stories.tsx', ['AllPalettes']],
      ['Design System/Typography', 'typography.stories.tsx', ['TypeScale']],
      ['Design System/Spacing', 'spacing.stories.tsx', ['Spacing']],
      ['Design System/Elevation', 'elevation.stories.tsx', ['Elevation']],
      ['Design System/Layering', 'layering.stories.tsx', ['Layering']],
      ['Design System/Interaction States', 'interaction-states.stories.tsx', ['ListRowStates', 'NeutralButtonStates', 'SolidButtonStates']],
    ];
    for (const [title, file, exports] of expected) {
      const storyPath = join(REPO_ROOT, 'packages', 'ui', 'stories', file);
      assert.ok(existsSync(storyPath), `${file} must exist as a Design System story`);
      const story = readFileSync(storyPath, 'utf8');
      assert.match(story, new RegExp(`title:\\s*['"]${title.replace(/\//g, '\\/')}['"]`), `${file} must have title ${title}`);
      for (const name of exports) {
        assert.match(story, new RegExp(`export const ${name}: Story`), `${file} must export ${name}`);
      }
    }
  });

  it('keeps interaction stories distinct and addressable by real browser state', () => {
    const story = readFileSync(join(REPO_ROOT, 'packages', 'ui', 'stories', 'interaction-states.stories.tsx'), 'utf8');

    for (const storyName of ['ListRowStates', 'NeutralButtonStates', 'SolidButtonStates']) {
      assert.doesNotMatch(story, new RegExp(`export const ${storyName}: Story = ButtonStates`));
    }
    for (const state of ['hover', 'active', 'focus', 'disabled', 'aria-disabled']) {
      assert.match(story, new RegExp(`data-state-target="${state}"`), `${state} must have a real browser target`);
    }
    assert.match(story, /play:\s*async \(\{ canvasElement \}\) =>/);
    assert.match(story, /querySelector<HTMLButtonElement>\('\[data-state-target="focus"\]'\)\?\.focus\(\)/);
  });

  it('keeps Design System stories free of undefined token references', () => {
    const tokensCss = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'maka-tokens.css'), 'utf8');
    const stylesCss = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8');
    const defined = new Set<string>([
      ...[...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
      ...[...stylesCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
    ]);
    const storiesDir = join(REPO_ROOT, 'packages', 'ui', 'stories');
    const storyFiles = readdirSync(storiesDir)
      .filter((f) => f.endsWith('.stories.tsx'));
    const undefinedRefs: string[] = [];
    for (const file of storyFiles) {
      const story = readFileSync(join(storiesDir, file), 'utf8');
      const referenced = new Set<string>();
      for (const m of story.matchAll(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g)) referenced.add(m[1]);
      for (const m of story.matchAll(/['"`](--[\w-]+)['"`]/g)) referenced.add(m[1]);
      for (const token of referenced) {
        if (!defined.has(token)) {
          undefinedRefs.push(`${file}: ${token}`);
        }
      }
    }
    assert.deepEqual(undefinedRefs, [], `Design System stories reference undefined tokens:\n  ${undefinedRefs.join('\n  ')}`);
  });

  it('storyboards provider settings states before visual polish', () => {
    const main = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'main.ts'), 'utf8');
    const storyPath = join(REPO_ROOT, 'apps', 'desktop', 'stories', 'settings', 'provider-settings.stories.tsx');
    assert.match(main, /apps\/desktop\/stories\/\*\*\/\*\.stories\.\@\(ts\|tsx\)/);
    assert.ok(existsSync(storyPath), 'Provider settings states must be inspectable in Storybook');

    const story = readFileSync(storyPath, 'utf8');
    assert.match(story, /title:\s*['"]Product\/Settings\/Providers['"]/);
    assert.match(story, /satisfies\s+Meta/);
    assert.match(story, /\bProvidersPanel\b/);
    assert.match(story, /ToastProvider/);
    assert.match(story, /className="settingsSurface"/);

    for (const storyName of [
      'Loading',
      'LoadError',
      'Empty',
      'ConfiguredProviders',
      'ProblemConnections',
      'SelectedDetail',
      'AddProvider',
      'OAuthCards',
      'XaiDeviceAuthorization',
    ]) {
      assert.match(story, new RegExp(`export const ${storyName}: Story`), `${storyName} story must be exported`);
    }

    assert.match(story, /ConnectionsBridge/, 'stories must drive ProvidersPanel through its bridge seam');
    assert.match(story, /claudeSubscription/, 'OAuth cards must render against story-local subscription fixtures');
    assert.match(story, /xaiOAuth/, 'xAI device authorization must render against a story-local OAuth fixture');
    assert.match(story, /ABCD-EFGH/, 'the xAI story must keep the user-facing device code visible');
    assert.doesNotMatch(storyPath, /src\/renderer/, 'desktop Storybook stories must stay out of the renderer build tree');
  });

  /**
   * The Models page mounts `ModelOAuthSection`, which reads its card state
   * straight off `window.maka` rather than through the `ConnectionsBridge`
   * prop. A channel the story bridge does not carry rejects on mount, and the
   * page still renders — every card frozen at its static "可用" label, the
   * Claude card hidden behind an experimental gate that never answered, and no
   * error banner. That is a screen the app never shows, which is exactly what
   * apps/desktop/stories/FIDELITY.md exists to keep out of Storybook.
   *
   * The channel list is derived from the renderer so a new one goes red here
   * instead of silently degrading the story. It is names only: a fixture that
   * carries `claudeSubscription` but not its gate method still passes the
   * derived half, so the gate is named separately below.
   */
  it('gives the Models settings page the subscription channels its cards read on mount', () => {
    const oauthSection = readFileSync(
      join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'provider-oauth-section.tsx'),
      'utf8',
    );
    const channels = [...new Set([...oauthSection.matchAll(/window\.maka\.(\w+)/g)].map((match) => match[1]))].sort();
    assert.ok(channels.length > 0, 'ModelOAuthSection must reach the preload bridge for its card state');

    const story = readFileSync(
      join(REPO_ROOT, 'apps', 'desktop', 'stories', 'settings', 'settings-pages.stories.tsx'),
      'utf8',
    );
    const bridge = story.slice(story.indexOf('const makaBridge = {'), story.indexOf('const withSettingsBridge'));
    assert.ok(bridge, 'settings-pages.stories.tsx must define the bridge its settings pages render against');

    const missing = channels.filter((channel) => !new RegExp(`^  ${channel}:`, 'm').test(bridge));
    assert.deepEqual(
      missing,
      [],
      `the Models story bridge is missing channels ModelOAuthSection calls on mount:\n${missing.join('\n')}`,
    );

    assert.match(
      bridge,
      /isExperimentalEnabled/,
      'the Claude card stays hidden until the experimental gate answers, so the story bridge must answer it',
    );
  });

  it('storyboards command palette and content search modal states before visual polish', () => {
    const storybookMain = readFileSync(join(REPO_ROOT, 'apps', 'desktop', '.storybook', 'main.ts'), 'utf8');
    const storyPath = join(REPO_ROOT, 'apps', 'desktop', 'stories', 'command-search.stories.tsx');

    assert.match(
      storybookMain,
      /apps\/desktop\/stories\/\*\*\/\*\.stories\.\@\(ts\|tsx\)/,
      'Desktop renderer stories must be discoverable by Storybook.',
    );
    assert.ok(existsSync(storyPath), 'Command/search modal states must be inspectable in Storybook');

    const story = readFileSync(storyPath, 'utf8');
    assert.match(story, /title:\s*['"]Product\/Command Search['"]/);
    assert.match(story, /satisfies\s+Meta/);
    assert.match(story, /\bCommandPalette\b/);
    assert.match(story, /\bSearchModal\b/);

    for (const storyName of [
      'CommandPaletteGroupedResults',
      'CommandPaletteNoMatch',
      'CommandPaletteKeyboardFocusedSelection',
      'CommandPaletteContentSearchLoading',
      'CommandPaletteContentSearchResults',
      'CommandPaletteContentSearchError',
      'CommandPaletteContentSearchBlocked',
      'SearchModalEmpty',
      'SearchModalLoading',
      'SearchModalResults',
      'SearchModalNoResults',
      'SearchModalError',
      'SearchModalBlocked',
    ]) {
      assert.match(story, new RegExp(`export const ${storyName}: Story`), `${storyName} story must be exported`);
    }

    assert.doesNotMatch(storyPath, /src\/renderer/, 'desktop Storybook stories must stay out of the renderer build tree');
    assert.doesNotMatch(story, /window\.maka/, 'Command/search stories must not depend on the preload bridge');
    assert.doesNotMatch(story, IMPORTS_APP_SHELL, 'Command/search stories must not import the desktop app shell');
  });

  it('keeps Storybook stories out of the regular @maka/ui TypeScript build', () => {
    const config = readTypescriptConfig(REPO_ROOT, join(REPO_ROOT, 'packages', 'ui', 'tsconfig.json'));

    assert.equal(
      (config.files ?? []).some((file) => /\.stories\.tsx?$/.test(file)),
      false,
      '@maka/ui tsc must not compile Storybook stories as part of the package build.',
    );
  });

  it('resolves TypeScript when worktrees borrow parent dependencies', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'maka-storybook-tsc-'));
    try {
      const parent = join(sandbox, 'repo');
      const repoRoot = join(parent, '.worktree', 'topic');
      const tscPath = join(parent, 'node_modules', 'typescript', 'bin', 'tsc');
      const configPath = join(repoRoot, 'packages', 'ui', 'tsconfig.json');

      mkdirSync(join(repoRoot, 'packages', 'ui'), { recursive: true });
      mkdirSync(join(parent, 'node_modules', 'typescript', 'bin'), { recursive: true });
      writeFileSync(join(repoRoot, 'package.json'), '{"private":true}', 'utf8');
      writeFileSync(configPath, '{}', 'utf8');
      writeFileSync(
        join(parent, 'node_modules', 'typescript', 'package.json'),
        '{"name":"typescript","main":"./bin/tsc"}',
        'utf8',
      );
      writeFileSync(
        tscPath,
        'console.log(JSON.stringify({ files: ["packages/ui/src/index.ts"] }));\n',
        'utf8',
      );

      const config = readTypescriptConfig(repoRoot, configPath);

      assert.deepEqual(config.files, ['packages/ui/src/index.ts']);
      assert.equal(existsSync(join(repoRoot, 'node_modules', '.bin', 'tsc')), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
