import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const rendererRoot = join(process.cwd(), 'src', 'renderer');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.[\]/+*]/g, (character) => `\\${character}`);
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
}

describe('permission composer takeover', () => {
  it('keeps Composer mounted while the permission surface owns its slot', async () => {
    const composerRegion = await readFile(join(rendererRoot, 'chat-composer-region.tsx'), 'utf8');
    const overlays = await readFile(join(rendererRoot, 'app-shell-overlays.tsx'), 'utf8');
    const composerBlock = composerRegion.match(/<Composer\s+ref=\{composerRef\}[\s\S]*?\/>/)?.[0] ?? '';

    assert.match(
      composerRegion,
      /className="maka-composer-interaction-slot"[\s\S]*?<PermissionPrompt/,
      'the permission prompt must render in the stable composer interaction slot',
    );
    assert.match(
      composerBlock,
      /hidden=\{[^}]*Boolean\(activeInteraction\)[^}]*\}/,
      'AppShell must tell Composer when an interaction surface owns its slot',
    );
    assert.doesNotMatch(
      await readFile(join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'composer.tsx'), 'utf8'),
      /if \(props\.hidden\) return null/,
      'hiding Composer must not destroy its uncontrolled textarea and draft',
    );
    assert.match(
      await readFile(join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'composer.tsx'), 'utf8'),
      /<form[\s\S]*?hidden=\{props\.hidden\}/,
      'Composer must retain its DOM and use the native hidden state during takeover',
    );
    assert.doesNotMatch(
      composerBlock,
      /disabled=\{Boolean\(activeInteraction\)\}/,
      'permission takeover replaces the composer instead of leaving a disabled composer behind it',
    );
    assert.doesNotMatch(
      overlays,
      /Permission(Dialog|Prompt)/,
      'permission is an in-flow composer interaction, not a global overlay',
    );
  });

  it('renders a non-modal permission region with an always-visible Stop action', async () => {
    const appShell = await readFile(join(rendererRoot, 'app-shell.tsx'), 'utf8');
    const composerRegion = await readFile(join(rendererRoot, 'chat-composer-region.tsx'), 'utf8');
    const permissionSource = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'permission-dialog.tsx'),
      'utf8',
    );
    const prompt = permissionSource.match(
      /export function PermissionPrompt[\s\S]*?function renderBrowserSummary/,
    )?.[0] ?? '';

    assert.doesNotMatch(prompt, /AlertDialog(Root|Content)/, 'the takeover must not enter the modal top layer');
    assert.match(prompt, /<section[\s\S]*?role="region"[\s\S]*?className="maka-composer-interaction maka-permission-prompt composer"/);
    assert.match(prompt, /onStop\(\): void \| Promise<void>/);
    assert.match(prompt, /disabled=\{props\.stopPending\}/);
    assert.match(prompt, /props\.stopPending \? copy\.stopping : copy\.stop/);
    assert.match(prompt, /const denyButtonRef = useRef<HTMLButtonElement>\(null\)/);
    assert.match(prompt, /denyButtonRef\.current\?\.focus\(\)/, 'focus must move from the hidden composer to the safe decision');
    assert.match(prompt, /ref=\{denyButtonRef\}[\s\S]*?submit\('deny'\)/);
    assert.match(
      composerRegion,
      /<PermissionPrompt[\s\S]*?onStop=\{stop\}[\s\S]*?stopPending=\{activeId \? stopPendingBySession\[activeId\] === true : false\}/,
      'the takeover must use the same stop owner and pending state as Composer',
    );
    assert.match(
      appShell,
      /const hasModalOpen = helpOpen \|\| paletteOpen \|\| searchModalOpen;/,
      'a permission prompt must not hide the live browser or make the workspace modal',
    );
  });

  it('presents one decision hierarchy without repeated risk or mixed-size action groups', async () => {
    const permissionSource = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'permission-dialog.tsx'),
      'utf8',
    );
    const prompt = permissionSource.match(
      /export function PermissionPrompt[\s\S]*?function renderBrowserSummary/,
    )?.[0] ?? '';

    assert.doesNotMatch(prompt, /maka-permission-subtitle/, 'the decision title must not repeat tool and reason metadata');
    assert.doesNotMatch(prompt, /maka-permission-danger-note/, 'destructive consequences must be stated once, not repeated');
    assert.doesNotMatch(prompt, /maka-permission-stale-note/, 'wait age metadata must not add a second warning block');
    assert.doesNotMatch(prompt, /maka-permission-icon|preset\.Icon/, 'the decision title does not need a second risk symbol');
    assert.match(
      prompt,
      /\{health\.status !== 'fresh' && \([\s\S]*?className="maka-permission-age"/,
      'fresh requests must not spend space saying that they just arrived',
    );
    assert.match(prompt, /const context = props\.request\.hint \?\? \(isDestructive/);
    assert.match(prompt, /className="maka-permission-context"/);
    assert.match(
      prompt,
      /<div className="maka-permission-utility-actions">[\s\S]*?\{showDisclosure && <CollapsibleTrigger>\{disclosureLabel\}<\/CollapsibleTrigger>\}[\s\S]*?permissionRemember[\s\S]*?<\/div>[\s\S]*?<div className="maka-permission-decision-actions" role="group" aria-label=\{copy\.actionsAriaLabel\}>[\s\S]*?props\.onStop[\s\S]*?submit\('deny'\)[\s\S]*?submit\('allow'\)/,
      'all three request actions belong to one adjacent group; disclosure and grant scope remain utilities',
    );
    assert.match(prompt, /variant="ghost"[\s\S]*?props\.onStop/);
    assert.match(prompt, /ref=\{denyButtonRef\}[\s\S]*?variant="ghost"[\s\S]*?submit\('deny'\)/);
    assert.match(prompt, /variant=\{isDestructive \? 'destructive' : 'default'\}[\s\S]*?submit\('allow'\)/);
    assert.doesNotMatch(
      prompt,
      /className="maka-button"/,
      'shared Button variants must not inherit the retired CSS button shell',
    );
    assert.equal(
      prompt.match(/size="md"/g)?.length,
      3,
      'all three high-stakes decisions must use the governed 13px control tier',
    );
    assert.doesNotMatch(prompt, /size="sm"/, 'caption-sized buttons are too small for high-stakes decisions');
    assert.doesNotMatch(prompt, /oklch\(from_var\(--destructive\)|hover:bg-/, 'permission actions must use governed Button variants');
  });

  it('keeps general disclosures focused on information not already present in the summary', async () => {
    const permissionSource = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'permission-dialog.tsx'),
      'utf8',
    );
    const prompt = permissionSource.match(
      /export function PermissionPrompt[\s\S]*?function renderBrowserSummary/,
    )?.[0] ?? '';
    const additionalArgs = permissionSource.match(
      /function permissionAdditionalArgs[\s\S]*?function permissionTextPreview/,
    )?.[0] ?? '';
    const summary = permissionSource.match(
      /function renderPermissionSummary[\s\S]*?function renderPermissionDetails/,
    )?.[0] ?? '';

    assert.match(prompt, /\{showDisclosure && \([\s\S]*?<CollapsiblePanel>/);
    assert.match(prompt, /const disclosureLabel = permissionDisclosureLabel\(props\.request, additionalArgs, copy\);/);
    assert.match(prompt, /\{showDisclosure && <CollapsibleTrigger>\{disclosureLabel\}<\/CollapsibleTrigger>\}/);
    assert.doesNotMatch(prompt, /formatRedactedJson\(props\.request\.args\)/, 'the disclosure must not repeat every summarized arg');
    assert.match(summary, /const commandSummary = cwd[\s\S]*?copy\.inDirectory\(redactSecrets\(cwd\)\)/);
    assert.match(additionalArgs, /case 'Bash':[\s\S]*?command: _command, cwd: _cwd[\s\S]*?return Object\.keys\(additional\)\.length > 0/);
  });

  it('uses the chat measure, compact composer geometry, and capped detail scrolling', async () => {
    const css = await readFile(join(rendererRoot, 'styles', 'permission-dialog.css'), 'utf8');
    const surface = ruleBody(css, '.maka-composer-interaction-inner');
    const summarySurface = ruleBody(css, '.maka-permission-summary');
    const summaryCode = ruleBody(css, '.maka-permission-summary .maka-code');
    const summaryPath = ruleBody(css, '.maka-permission-summary .maka-permission-path code');
    const detailPanel = ruleBody(css, '.maka-permission-raw [data-slot="collapsible-panel"]');
    const dangerNote = ruleBody(css, '.maka-permission-danger-note');
    const rawCode = ruleBody(css, '.maka-permission-raw .maka-code');

    assert.match(surface, /width:\s*min\(var\(--maka-chat-measure\), 100%\)/);
    assert.match(surface, /border:\s*var\(--border-width-hairline\) solid var\(--border\)/);
    assert.match(surface, /border-radius:\s*var\(--radius-surface\)/);
    assert.match(surface, /display:\s*grid/);
    assert.match(summarySurface, /min-height:\s*var\(--h-control-lg\)/, 'every compact card needs the same operation-object slot');
    assert.match(summarySurface, /grid-template-columns:\s*minmax\(0, 1fr\) auto/, 'primary object and compact metadata share one stable row');
    assert.match(summarySurface, /padding:\s*var\(--space-2\) var\(--space-2-5\)/);
    assert.match(summarySurface, /border:\s*var\(--border-width-hairline\) solid var\(--border\)/);
    assert.match(summarySurface, /background:\s*var\(--foreground-2\)/);
    assert.match(summaryCode, /padding:\s*0/);
    assert.match(summaryCode, /border:\s*0/);
    assert.match(summaryCode, /background:\s*transparent/);
    assert.match(summaryPath, /padding:\s*0/);
    assert.match(summaryPath, /border:\s*0/);
    assert.match(summaryPath, /background:\s*transparent/);
    assert.match(summaryPath, /min-width:\s*0/);
    assert.match(summaryPath, /text-overflow:\s*ellipsis/);
    assert.match(ruleBody(css, '.maka-permission-meta'), /white-space:\s*nowrap/);
    assert.match(detailPanel, /max-height:\s*min\(32vh, 220px\)/);
    assert.match(detailPanel, /overflow:\s*auto/);
    assert.match(rawCode, /max-height:\s*none/);
    assert.match(rawCode, /overflow:\s*visible/);
    assert.equal(dangerNote, '', 'the repeated destructive warning style must be removed');
    assert.match(ruleBody(css, '.maka-permission-context'), /font-size:\s*var\(--font-size-ui\)/);
    const disclosure = ruleBody(css, '.maka-permission-raw [data-slot="collapsible-trigger"]');
    assert.match(disclosure, /font-size:\s*var\(--font-size-ui\)/);
    assert.match(disclosure, /width:\s*auto/, 'the shared full-width trigger must not break the utility row');
    assert.match(ruleBody(css, '.maka-permission-utility-actions'), /flex-wrap:\s*nowrap/);
    assert.match(ruleBody(css, '.permissionRemember'), /font-size:\s*var\(--font-size-ui\)/);
    const decisionActions = ruleBody(css, '.maka-permission-decision-actions');
    assert.match(decisionActions, /grid-template-columns:\s*repeat\(3, minmax\(88px, 1fr\)\)/);
    assert.match(decisionActions, /gap:\s*var\(--space-1\)/);
    assert.doesNotMatch(css, /\.maka-permission-decision-actions \.maka-button(?::hover|:active)?\s*\{/, 'Button primitive owns interaction states');
    assert.doesNotMatch(css, /\.maka-permission-icon\b/, 'removed title decoration must not leave dead CSS');
    assert.doesNotMatch(css, /\.permissionDialog\b/, 'the old modal geometry must be removed');
  });

  it('keeps all question actions inside the narrow composer container', async () => {
    const css = await readFile(join(rendererRoot, 'styles', 'permission-dialog.css'), 'utf8');
    const questionActions = ruleBody(css, '.permissionActions.maka-question-actions');

    assert.match(questionActions, /display:\s*grid/);
    assert.match(questionActions, /grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto/);
    assert.match(css, /@container \(max-width: 460px\)[\s\S]*?\.permissionActions\.maka-question-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  });

  it('keeps long previews and diffs inside the capped disclosure', async () => {
    const permissionSource = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'permission-dialog.tsx'),
      'utf8',
    );
    const prompt = permissionSource.match(
      /export function PermissionPrompt[\s\S]*?function renderBrowserSummary/,
    )?.[0] ?? '';
    const summary = permissionSource.match(
      /function renderPermissionSummary[\s\S]*?function renderPermissionDetails/,
    )?.[0] ?? '';
    const details = permissionSource.match(
      /function renderPermissionDetails[\s\S]*?function permissionTextPreview/,
    )?.[0] ?? '';

    assert.match(prompt, /<CollapsibleTrigger>\{disclosureLabel\}<\/CollapsibleTrigger>/);
    assert.match(prompt, /const prompt = permissionPrompt\(props\.request, preset, copy\);/);
    assert.match(prompt, /id="permissionTitle">\{prompt\}<\/h2>/);
    assert.match(summary, /case 'Edit':[\s\S]*?countTextLines\(oldString\)[\s\S]*?copy\.editLineCount\(oldLines, newLines\)/);
    assert.doesNotMatch(summary, /即将修改文件/);
    assert.doesNotMatch(summary, /即将写入文件/);
    assert.match(summary, /case 'WebFetch':[\s\S]*?args\.url[\s\S]*?maka-permission-path/);
    assert.match(summary, /default:[\s\S]*?request\.toolName[\s\S]*?maka-permission-line/);
    assert.doesNotMatch(summary, /maka-permission-diff/, 'diffs do not belong in the compact summary');
    assert.match(details, /maka-permission-diff/, 'diffs remain inspectable in expanded details');
    assert.doesNotMatch(details, /maka-permission-diff-tag/, 'expanded edits use one unified diff instead of stacked labeled cards');
    assert.match(details, /maka-permission-preview/, 'long content previews remain inspectable in expanded details');
  });
});
