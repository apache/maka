import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// #520 PR9 commit 2: settings status chips converge onto a dedicated Chip
// primitive (squared, compact, status-tone), NOT the pill Badge primitive.
// Badge and Chip are two distinct UI roles — pill Badge for emphasis markers
// (health/permission center), squared Chip for dense settings status rows.
//
// This contract locks the role split (Chip radius-control not pill, Badge
// stays pill) AND the user-visible tokens of Chip (neutral bg/text, sm/default
// size geometry, status-tone alphas) so a cva class change that preserves the
// import is still caught. Token values reproduce the retired
// .settingsBadge (sm: 18px/400/0-6px padding/foreground-5) and
// .settingsConnectionBadge (default: 20px/600/2-8px/foreground-5, tone alphas
// /12 /14 /18 /15) CSS so settings visuals do not drift.
test('chip converge (#520 PR9)', async () => {
  const chipSrc = read('packages/ui/src/primitives/chip.tsx');

  // 1. Chip primitive exists + carries data-slot
  assert.match(chipSrc, /export function Chip/, 'Chip primitive must be exported');
  assert.match(chipSrc, /["']?data-slot["']?\s*[:=]\s*["']chip["']/, 'Chip must carry data-slot="chip"');

  // 2. Chip locks radius-control (squared), never pill — role split with Badge
  assert.match(chipSrc, /rounded-\[var\(--radius-control\)\]/, 'Chip must use radius-control (squared, not pill)');
  assert.doesNotMatch(chipSrc, /rounded-\[var\(--radius-pill\)\]/, 'Chip must not regress to pill');

  // 3. index.ts re-exports Chip
  const indexSrc = read('packages/ui/src/index.ts');
  assert.match(indexSrc, /export (?:\*|\{[^}]*\bChip\b[^}]*\}) from ['"]\.\/primitives\/chip\.js['"]/, 'index.ts must re-export Chip');

  // 4. settings CSS chips retired
  const botCss = read('apps/desktop/src/renderer/styles/settings/bot.css');
  assert.doesNotMatch(botCss, /\.settingsBadge\s*\{/, '.settingsBadge CSS rule must be retired');
  const connCss = read('apps/desktop/src/renderer/styles/settings/connection.css');
  assert.doesNotMatch(connCss, /\.settingsConnectionBadge\s*[\{[,]/, '.settingsConnectionBadge CSS rule must be retired');

  // 5. settings chip sites use the Chip primitive (squared status role, not pill Badge)
  const CHIP_IMPORT_RE =
    /import\s+\{[^}]*\bChip\b[^}]*\}\s+from\s+['"][^'"]*?(?:@maka\/ui|primitives\/chip\.js)['"]/;
  const settingsChipFiles = [
    'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
    'apps/desktop/src/renderer/settings/provider-add-form.tsx',
    'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
    'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
    // #1042: the Chip call sites in the OAuth section moved with
    // ClaudeSubscriptionCard into its own file.
    'apps/desktop/src/renderer/settings/claude-subscription-card.tsx',
    // Round 1 convergence (#520 follow-up): hand-rolled status-chip recipes
    // collapsed onto Chip. These call sites GAIN Chip coverage — the retired
    // CSS labels (settingsBotStatusPill, providerCatalogBadge.is-state, and
    // the packages/ui status labels) now render the primitive.
    // #1042: the bot-chat page split; the dotted Chip rows live in the
    // overview + detail views now.
    'apps/desktop/src/renderer/settings/bot-chat-overview.tsx',
    'apps/desktop/src/renderer/settings/bot-chat-detail.tsx',
    'apps/desktop/src/renderer/settings/provider-catalog.tsx',
    'packages/ui/src/skills-panel.tsx',
    'packages/ui/src/plan-reminder-panel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
  ];
  for (const rel of settingsChipFiles) {
    assert.match(read(rel), CHIP_IMPORT_RE, `${rel} must import Chip`);
  }

  // 5b. Chip gains a `dot` prop (leading 6px currentColor round dot) — the
  // "● 已连接" affordance retired from .settingsBotStatusPill. bot-chat renders
  // the dotted Chip so the connection affordance survives the migration.
  assert.match(chipSrc, /\bdot\?:\s*boolean/, 'Chip must expose a dot? prop');
  assert.match(
    chipSrc,
    /data-slot="chip-dot"[\s\S]*bg-current[\s\S]*opacity-70/,
    'Chip dot must be a currentColor round dot at 70% alpha',
  );
  const botChatSrc = read('apps/desktop/src/renderer/settings/bot-chat-detail.tsx');
  assert.match(botChatSrc, /<Chip\s+dot\b/, 'BotStatusPill must render a dotted Chip');
  assert.match(
    read('apps/desktop/src/renderer/settings/bot-chat-overview.tsx'),
    /<Chip\s+dot\b/,
    'BotStatusPill must render a dotted Chip in the overview rows',
  );
  assert.doesNotMatch(
    read('apps/desktop/src/renderer/styles/settings/bot.css'),
    /\.settingsBotStatusPillDot\s*\{/,
    'settingsBotStatusPillDot CSS must be retired (dot now lives on Chip)',
  );

  // 6. Chip neutral variant tokens — bg = foreground-5 (bg-secondary aliases
  //    --color-secondary = var(--foreground-5)), text = foreground-secondary
  assert.match(chipSrc, /neutral: "bg-secondary text-\[var\(--foreground-secondary\)\]"/, 'Chip neutral bg must be foreground-5 (bg-secondary) and text foreground-secondary');

  // 7. Chip size tokens — sm reproduces .settingsBadge (18px/400/0-6px),
  //    default reproduces .settingsConnectionBadge (20px/600/2-8px)
  assert.match(chipSrc, /min-h-4\.5 px-\[var\(--space-1-5\)\] py-0 font-normal/, 'Chip sm size must reproduce .settingsBadge (18px / 400 / 0-6px padding)');
  assert.match(chipSrc, /min-h-5 px-\[var\(--space-2\)\] py-\[var\(--space-0-5\)\] font-semibold/, 'Chip default size must reproduce .settingsConnectionBadge (20px / 600 / 2-8px padding)');

  // 8. Chip status-tone variant tokens — reproduce retired CSS oklch alphas
  assert.match(chipSrc, /bg-info\/14/, 'Chip info variant must keep /14 alpha (matches .settingsConnectionBadge info)');
  assert.match(chipSrc, /bg-success\/12/, 'Chip success variant must keep /12 alpha');
  assert.match(chipSrc, /bg-warning\/18/, 'Chip warning variant must keep /18 alpha');
  assert.match(chipSrc, /bg-destructive\/15/, 'Chip destructive variant must keep /15 alpha (not solid red)');

  // 8b. Chip accent variant (default-connection marker) — brand tone on the
  // background only. Raw --nav-active text is 2.66:1 on white (fails WCAG AA;
  // see design-system-governance-406 permission-mode chip contract), so the
  // label must use --foreground-secondary like the readable-accent precedent.
  assert.match(
    chipSrc,
    /accent: "bg-nav-active\/14 text-\[var\(--foreground-secondary\)\]/,
    'Chip accent variant must keep the nav-active /14 wash with foreground-secondary text (never raw nav-active text)',
  );

  // 9. Dual-track Badge (pill) + Chip (squared) preserved. #1565 PR 3: Badge
  // is the Astryx primitive (its pill shape is Astryx-owned, not a local
  // recipe this contract can inspect); the barrel re-export is pinned by
  // badge-converge-contract.
});
