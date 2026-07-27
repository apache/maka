/**
 * Icon + typography governance contract.
 *
 * The sidebar's competitor comparison surfaced three fault lines:
 *   1. Icon semantics were wrong (Sparkles for 技能 means nothing).
 *   2. Icons read as different families — call sites had accumulated a
 *      dozen different `strokeWidth` values, so the glyphs fragmented.
 *   3. The lucide funnel could drift if a call site imported lucide-react
 *      directly instead of through the @maka/ui/icons seam.
 *
 * This contract pins the outcome of the governance round:
 *   a) No `strokeWidth={...}` prop survives on lucide icon call sites under
 *      apps/desktop/src/renderer or packages/ui/src (brand-asset files
 *      excepted) — icons ride the single governed stroke instead.
 *   b) session-sidebar-nav.tsx imports exactly the decided semantic set
 *      (SquarePen / CalendarCheck / Blocks / Timer / Settings) from ./icons.js.
 *   c) icons.tsx stays the ONLY packages/ui/src file importing lucide-react
 *      (funnel integrity).
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { CATALOG_PROVIDER_TYPES } from '@maka/core';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const ICONS_FILE = resolve(REPO_ROOT, 'packages/ui/src/icons.tsx');
const SIDEBAR_NAV_FILE = resolve(REPO_ROOT, 'packages/ui/src/session-sidebar-nav.tsx');
const PROVIDER_BRAND_MARKS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-brand-marks.tsx');
const PROVIDER_CATALOG_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-catalog.tsx');
const PROVIDER_CONNECTION_DIALOG_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-connection-dialog.tsx');
const MINIMAX_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/minimax-logo-only-vertical-color-bg-white-text.svg',
);
const XAI_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/xai.svg');
const XIAOMI_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/xiaomimimo.svg');
const ZAI_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/zai.svg');
const VERCEL_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/vercel.svg');
const CEREBRAS_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/cerebras.svg');
const MISTRAL_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/mistral.svg');
const COHERE_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/cohere.svg');
const HUGGINGFACE_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/huggingface.svg');
const ZENMUX_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/zenmux.svg');
const TOGETHER_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/together.svg');
const DEEPINFRA_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/deepinfra.svg');
const GROQ_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/groq.svg');
const OPENROUTER_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/openrouter.svg');
const ALIBABA_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/alibabacloud.svg');
const CLOUDFLARE_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/cloudflare.svg');
const FIREWORKS_BRAND_MARK_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/fireworks.svg',
);
const GITHUB_COPILOT_BRAND_MARK_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/github-copilot.svg',
);
const NVIDIA_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/nvidia.svg');
const TENCENT_HUNYUAN_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/hunyuan.svg');
const TENCENT_CLOUD_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/tencentcloud.svg');
const STEPFUN_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/stepfun.svg');
const VOLCENGINE_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/volcengine.svg');
const DESKTOP_PACKAGE_FILE = resolve(REPO_ROOT, 'apps/desktop/package.json');
const THIRD_PARTY_NOTICES_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt');
const ONBOARDING_HERO_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/OnboardingHero.tsx');
const LM_STUDIO_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/lmstudio.svg',
);
const LOCALAI_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/localai.svg',
);
const OPENCODE_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/opencode.svg',
);

// Fixed brand assets, not generic UI icons — their vendored SVGs keep
// their own stroke weight and are exempt from the call-site stroke sweep.
const STROKE_EXCEPTION_FILES = new Set([
  resolve(REPO_ROOT, 'packages/ui/src/bot-brand-logo.tsx'),
  resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-brand-marks.tsx'),
]);

// Governance: inline hand-drawn `<svg>` literals are an anti-pattern —
// generic UI glyphs must ride the @maka/ui/icons lucide funnel so they share
// one stroke, one sizing seam, and one family. The ONLY files allowed to hold
// a raw `<svg>` are the vendored/library *brand* marks (each audited below);
// they carry official logo geometry that no generic icon can stand in for:
//   - packages/ui/src/bot-brand-logo.tsx — Telegram/Feishu/WeCom/… channel
//     brand logos (the icon-set-no-direct-lucide contract pins each provider
//     to a local SVG component, so this file MUST keep inline SVG).
//   - apps/desktop/src/renderer/settings/provider-brand-marks.tsx — the LLM
//     provider brand marks (SiliconCloud, Ollama, xAI, …); every path here is
//     byte-provenance-pinned above to an upstream brand package.
//   - packages/ui/src/maka-wordmark.tsx — Maka's own wordmark (#1433). The
//     one mark here that is first-party rather than vendored: its path was
//     traced with potrace from the `maka` lockup in
//     apps/desktop/assets/icon.png, so the geometry has the same "official
//     logo, reproduced exactly" provenance the vendored marks have. lucide
//     obviously ships no Maka glyph, and routing a product logo through the
//     generic icon funnel would subject it to the shared stroke and sizing
//     seam, which is exactly what a mark must not follow.
//   - apps/desktop/src/renderer/mcp-brand-marks.tsx — the MCP catalog brand
//     marks. This is the SANCTIONED pattern for library-sourced marks: the
//     `<svg>` is an inert MOUNTING SHELL that wraps `<path>` children whose
//     geometry comes straight from a brand library (simple-icons, plus
//     @ant-design/icons-svg for DingTalk and the vendored @douyinfe/semi-icons
//     Feishu mark) — official brand paths, not hand-drawn art. Lucide ships no
//     brand icons, so these marks cannot route through @maka/ui/icons. The
//     rot-guard below still holds because the file genuinely contains an inline
//     `<svg>`.
// packages/ui/src/icons.tsx is NOT listed: it is a pure lucide re-export with
// zero `<svg>` literals, so it needs no exemption. Any NEW raw `<svg>` under
// the two source trees must fail this suite and move to @maka/ui/icons — unless
// it is a library/vendored brand mark added to this allowlist with the same
// justification (inert shell around library-sourced path geometry).
const INLINE_SVG_ALLOWLIST = new Set([
  resolve(REPO_ROOT, 'packages/ui/src/bot-brand-logo.tsx'),
  resolve(REPO_ROOT, 'packages/ui/src/maka-wordmark.tsx'),
  resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-brand-marks.tsx'),
  resolve(REPO_ROOT, 'apps/desktop/src/renderer/mcp-brand-marks.tsx'),
]);

async function walkTsx(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTsx(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');

describe('icon + typography governance contract', () => {
  it('rides lucide\'s single governed stroke — no per-call-site strokeWidth props', async () => {
    const dirs = [
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of await walkTsx(dir)) {
        if (STROKE_EXCEPTION_FILES.has(file)) continue;
        const src = await readFile(file, 'utf8');
        // The brace form is what lucide icon call sites use. Raw inline
        // <svg> primitives use the string form (strokeWidth="2") and are
        // not lucide glyphs, so they are outside this rule.
        if (/strokeWidth=\{/.test(src)) offenders.push(rel(file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'icons ride lucide\'s default stroke — per-callsite strokeWidth fragments the family. '
        + `Delete the strokeWidth={...} props in:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('bans inline hand-drawn <svg> in .tsx outside the brand-mark allowlist', async () => {
    // Machine-walk both source trees the same way the repo-wide
    // OverlayScrollbars ban walks its workspaces — any .tsx that isn't a
    // vendored brand mark must route generic glyphs through @maka/ui/icons
    // instead of hand-drawing an <svg>.
    const dirs = [
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ];
    const offenders: string[] = [];
    const seenAllowlisted = new Set<string>();
    for (const dir of dirs) {
      for (const file of await walkTsx(dir)) {
        const src = await readFile(file, 'utf8');
        const hasInlineSvg = /<svg[\s/>]/.test(src);
        if (INLINE_SVG_ALLOWLIST.has(file)) {
          if (hasInlineSvg) seenAllowlisted.add(file);
          continue;
        }
        if (hasInlineSvg) offenders.push(rel(file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Inline hand-drawn <svg> is an anti-pattern — replace it with a semantically-correct '
        + 'icon from @maka/ui/icons (add the re-export to packages/ui/src/icons.tsx if missing). '
        + `Offending files:\n  ${offenders.join('\n  ')}`,
    );
    // Guard the allowlist against rot: if a listed brand-mark file no longer
    // holds inline SVG, drop it from INLINE_SVG_ALLOWLIST rather than leaving a
    // stale exemption that would silently re-permit a future offender.
    for (const file of INLINE_SVG_ALLOWLIST) {
      assert.ok(
        seenAllowlisted.has(file),
        `${rel(file)} is allowlisted for inline SVG but no longer contains any — remove it from INLINE_SVG_ALLOWLIST`,
      );
    }
  });

  it('session-sidebar-nav imports exactly the decided semantic icon set from ./icons.js', async () => {
    const src = await readFile(SIDEBAR_NAV_FILE, 'utf8');
    const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/icons\.js'/);
    assert.ok(importMatch, 'session-sidebar-nav.tsx must import its icons from ./icons.js');
    const imported = importMatch![1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    // Hub-level mapping: 新任务 → SquarePen, 扩展 → Blocks,
    // 定时任务 → Timer, 设置 → Settings. Skills/MCP and Plan reminders/
    // Daily review switch inside their main surfaces, not in sidebar rows.
    const expected = ['Blocks', 'Settings', 'SquarePen', 'Timer'];
    assert.deepEqual(
      imported,
      expected,
      `session-sidebar-nav.tsx must import exactly ${expected.join('/')} from ./icons.js (the semantic mapping)`,
    );
  });

  it('routes every packages/ui/src lucide import through the icons.tsx funnel', async () => {
    const files = await walkTsx(resolve(REPO_ROOT, 'packages/ui/src'));
    const offenders: string[] = [];
    for (const file of files) {
      if (file === ICONS_FILE) continue;
      const stripped = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/['"]lucide-react['"]/.test(stripped)) offenders.push(rel(file));
    }
    assert.deepEqual(
      offenders,
      [],
      'icons.tsx is the only lucide-react seam in packages/ui/src (funnel integrity). '
        + `Route these through @maka/ui/icons named exports:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('uses the vendored SiliconCloud brand mark for SiliconFlow', async () => {
    const src = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');

    assert.match(
      src,
      /function SiliconCloud\(\)[\s\S]*d="M22\.956 6\.521H12\.522c-\.577 0-1\.044\.468-1\.044 1\.044v3\.13/,
      'SiliconFlow must use the upstream @lobehub/icons-static-svg SiliconCloud path, not a hand-drawn placeholder',
    );
    assert.match(
      src,
      /case 'siliconflow':\s*return <SiliconCloud \/>/,
      'the SiliconFlow provider must resolve to its real brand mark',
    );
  });

  it('routes the MiniMax Coding Plan alias to the MiniMax brand mark', async () => {
    const src = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');

    assert.match(
      src,
      /case 'minimax-coding-plan':\s*case 'MiniMax':\s*case 'MiniMax-cn':\s*return <MiniMaxMark \/>/,
      'MiniMax Coding Plan must reuse the MiniMax brand mark instead of the generic placeholder',
    );
  });

  it('vendors the byte-exact official MiniMax brand-package SVG', async () => {
    const componentSrc = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');
    const asset = await readFile(MINIMAX_BRAND_ASSET_FILE);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '386033f6d1cfc5359877b402221a819f272cf6333eae12a95858fdcc226811a5',
      'MiniMax mark must remain byte-identical to the official brand-package member',
    );
    assert.match(componentSrc, /https:\/\/platform\.minimax\.io\/docs\/faq\/contact-us#brand-resources/);
    assert.match(componentSrc, /https:\/\/file\.cdn\.minimax\.io\/public\/MiniMax_Logo\.zip/);
    assert.match(
      componentSrc,
      /MiniMax_Logo\/svg\/logo-only\/vertical\/minimax_logo-only_vertical_color-bg_white-text\.svg/,
    );
    assert.match(
      componentSrc,
      /function MiniMaxMark\(\): ReactElement \{\s*return <img src=\{minimaxBrandMark\} alt="" \/>;\s*\}/,
      'MiniMax providers must render the vendored official file, never an inline hand-drawn path',
    );
  });

  it('uses the unmodified upstream xAI mark across catalog and provider detail surfaces', async () => {
    const [marks, catalog, providerDialog, xaiMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(PROVIDER_CATALOG_FILE, 'utf8'),
      readFile(PROVIDER_CONNECTION_DIALOG_FILE, 'utf8'),
      readFile(XAI_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(xaiMark).digest('hex'),
      '89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451',
      'the vendored xAI mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 xai.svg',
    );
    assert.match(
      marks,
      /Real xAI\/Grok mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*32f4083f7a20b67ecdc7b29c0af031ada5a29c52[\s\S]*packages\/static-svg\/icons\/xai\.svg[\s\S]*license: MIT[\s\S]*function XAI\(\)[\s\S]*<ProviderAssetMask src=\{xaiMarkUrl\} \/>/,
      'xAI must render the traceable upstream SVG asset as a currentColor mask instead of a generic or hand-drawn mark',
    );
    assert.match(
      marks,
      /case 'xai':\s*case 'xai-oauth':\s*return <XAI \/>/,
      'both xAI credential paths must resolve to the same upstream mark',
    );
    assert.match(catalog, /<ProviderLogo type=\{props\.type\} \/>/, 'catalog cards must consume the shared provider logo seam');
    assert.match(
      providerDialog,
      /<DialogHeader[\s\S]*icon=\{<ProviderLogo type=\{props\.providerType\} compact \/>\}/,
      'saved connection detail must consume the shared provider logo seam',
    );
  });

  it('vendors and renders the byte-exact Lobe Icons Together AI color SVG', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(TOGETHER_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '27ccaf118a431c386b88418a34a4346afd9638dde10e3f2295db2eec1fa5898a',
      'Together AI SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 together-color.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(marks, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(marks, /packages\/static-svg\/icons\/together-color\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /27ccaf118a431c386b88418a34a4346afd9638dde10e3f2295db2eec1fa5898a/);
    assert.match(marks, /import togetherBrandMark from '\.\.\/assets\/provider-brands\/together\.svg';/);
    assert.match(marks, /case 'togetherai':\s*return <img src=\{togetherBrandMark\} alt="" \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/together\.svg[\s\S]*packages\/static-svg\/icons\/together-color\.svg[\s\S]*27ccaf118a431c386b88418a34a4346afd9638dde10e3f2295db2eec1fa5898a/,
    );
  });

  it('vendors and renders the byte-exact Lobe Icons DeepInfra color SVG', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(DEEPINFRA_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      'bfc78853fe658f6446651d03218f3e809215fd7cb3bce841a6526de383286544',
      'DeepInfra SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 deepinfra-color.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(marks, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(marks, /packages\/static-svg\/icons\/deepinfra-color\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /bfc78853fe658f6446651d03218f3e809215fd7cb3bce841a6526de383286544/);
    assert.match(marks, /import deepinfraBrandMark from '\.\.\/assets\/provider-brands\/deepinfra\.svg';/);
    assert.match(marks, /case 'deepinfra':\s*return <img src=\{deepinfraBrandMark\} alt="" \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/deepinfra\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/deepinfra-color\.svg[\s\S]*bfc78853fe658f6446651d03218f3e809215fd7cb3bce841a6526de383286544/,
    );
  });

  it('vendors and renders the byte-exact Lobe Icons Groq SVG', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(GROQ_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '078d5cf6e7a54905040c15ddacf5ea33c13042fe7739e820cedc2096e4406651',
      'Groq SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 groq.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(marks, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(marks, /packages\/static-svg\/icons\/groq\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /078d5cf6e7a54905040c15ddacf5ea33c13042fe7739e820cedc2096e4406651/);
    assert.match(marks, /import groqBrandMark from '\.\.\/assets\/provider-brands\/groq\.svg';/);
    assert.match(marks, /case 'groq':\s*return <ProviderAssetMask src=\{groqBrandMark\} \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/groq\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/groq\.svg[\s\S]*078d5cf6e7a54905040c15ddacf5ea33c13042fe7739e820cedc2096e4406651/,
    );
  });

  it('vendors and renders the byte-exact Lobe Icons OpenRouter color SVG', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(OPENROUTER_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '17bede1b89166f824ee06753dc526a3f5e18b769706deaab09d04a3a98de1a78',
      'OpenRouter SVG must remain byte-identical to @lobehub/icons-static-svg@1.92.0 openrouter-color.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.92\.0/);
    assert.match(marks, /df132de5a0cef315b9a2f155b1949e39f4b89bb5/);
    assert.match(marks, /packages\/static-svg\/icons\/openrouter-color\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /17bede1b89166f824ee06753dc526a3f5e18b769706deaab09d04a3a98de1a78/);
    assert.match(marks, /import openrouterBrandMark from '\.\.\/assets\/provider-brands\/openrouter\.svg';/);
    assert.match(marks, /case 'openrouter':\s*return <img src=\{openrouterBrandMark\} alt="" \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/openrouter\.svg[\s\S]*df132de5a0cef315b9a2f155b1949e39f4b89bb5[\s\S]*packages\/static-svg\/icons\/openrouter-color\.svg[\s\S]*17bede1b89166f824ee06753dc526a3f5e18b769706deaab09d04a3a98de1a78/,
    );
  });

  it('vendors and renders the byte-exact Lobe Icons Alibaba Cloud color SVG', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(ALIBABA_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '73ea97baf919edb3d888a77cd45b21574e190a80124a59e199ea6953a28a959c',
      'Alibaba Cloud SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 alibabacloud-color.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(marks, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(marks, /packages\/static-svg\/icons\/alibabacloud-color\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /73ea97baf919edb3d888a77cd45b21574e190a80124a59e199ea6953a28a959c/);
    assert.match(marks, /import alibabaBrandMark from '\.\.\/assets\/provider-brands\/alibabacloud\.svg';/);
    assert.match(
      marks,
      /case 'alibaba':\s*case 'alibaba-coding-plan-cn':\s*case 'alibaba-coding-plan':\s*case 'alibaba-token-plan-cn':\s*case 'alibaba-token-plan':\s*return <img src=\{alibabaBrandMark\} alt="" \/>/,
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/alibabacloud\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/alibabacloud-color\.svg[\s\S]*73ea97baf919edb3d888a77cd45b21574e190a80124a59e199ea6953a28a959c/,
    );
  });

  it('vendors and routes the byte-exact Vercel SVG through the shared provider logo seam', async () => {
    const [marks, asset, notices, catalog, providerDialog, onboardingHero] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(VERCEL_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
      readFile(PROVIDER_CATALOG_FILE, 'utf8'),
      readFile(PROVIDER_CONNECTION_DIALOG_FILE, 'utf8'),
      readFile(ONBOARDING_HERO_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '4874d52d8b2ce7c309cbd10c424fee123b2c9483e76d76ad0dca41794483eb24',
      'Vercel SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 vercel.svg',
    );
    assert.match(
      marks,
      /Vercel mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*32f4083f7a20b67ecdc7b29c0af031ada5a29c52[\s\S]*packages\/static-svg\/icons\/vercel\.svg[\s\S]*license: MIT[\s\S]*4874d52d8b2ce7c309cbd10c424fee123b2c9483e76d76ad0dca41794483eb24/,
    );
    assert.match(marks, /import vercelBrandMark from '\.\.\/assets\/provider-brands\/vercel\.svg';/);
    assert.match(marks, /case 'vercel':\s*return <ProviderAssetMask src=\{vercelBrandMark\} \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/vercel\.svg[\s\S]*32f4083f7a20b67ecdc7b29c0af031ada5a29c52[\s\S]*packages\/static-svg\/icons\/vercel\.svg[\s\S]*4874d52d8b2ce7c309cbd10c424fee123b2c9483e76d76ad0dca41794483eb24/,
    );
    assert.match(catalog, /<ProviderLogo type=\{props\.type\} \/>/);
    assert.match(providerDialog, /<ProviderLogo type=\{props\.providerType\} compact \/>/);
    assert.match(onboardingHero, /<ProviderLogo type=\{type\} compact \/>/);
  });

  it('vendors and renders the byte-exact Cloudflare color SVG through the notice seam', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(CLOUDFLARE_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      'cee35d3f0ecb7925ce0a89aeaff8b907cadae7c3fe44a23e4001cc8d5ee57502',
      'Cloudflare SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0',
    );
    assert.match(
      marks,
      /Cloudflare mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/cloudflare-color\.svg[\s\S]*license: MIT[\s\S]*SHA-256: cee35d3f0ecb7925ce0a89aeaff8b907cadae7c3fe44a23e4001cc8d5ee57502/,
    );
    assert.match(marks, /import cloudflareMarkUrl from '\.\.\/assets\/provider-brands\/cloudflare\.svg';/);
    assert.match(
      marks,
      /case 'cloudflare-workers-ai':\s*return <img src=\{cloudflareMarkUrl\} alt="" \/>/,
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/cloudflare\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/cloudflare-color\.svg[\s\S]*cee35d3f0ecb7925ce0a89aeaff8b907cadae7c3fe44a23e4001cc8d5ee57502/,
    );
  });

  it('vendors and renders the byte-exact Lobe Icons Hugging Face color SVG', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(HUGGINGFACE_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '5d39d66bb6c9b026d3cb5de7bd9978dad3906570df2aca8f00078a6f8a3d0f5e',
      'Hugging Face SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 huggingface-color.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(marks, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(marks, /packages\/static-svg\/icons\/huggingface-color\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /5d39d66bb6c9b026d3cb5de7bd9978dad3906570df2aca8f00078a6f8a3d0f5e/);
    assert.match(marks, /import huggingfaceBrandMark from '\.\.\/assets\/provider-brands\/huggingface\.svg';/);
    assert.match(marks, /case 'huggingface':\s*return <img src=\{huggingfaceBrandMark\} alt="" \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/huggingface\.svg[\s\S]*packages\/static-svg\/icons\/huggingface-color\.svg[\s\S]*5d39d66bb6c9b026d3cb5de7bd9978dad3906570df2aca8f00078a6f8a3d0f5e/,
    );
  });

  it('vendors and renders the byte-exact Fireworks color SVG through the notice seam', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(FIREWORKS_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      'f1c4782b86bc03a36323fd68ad6cc376c6b2ebe57b701cc958ebd6b8d37effd6',
      'Fireworks SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0',
    );
    assert.match(
      marks,
      /Fireworks mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/fireworks-color\.svg[\s\S]*license: MIT[\s\S]*SHA-256: f1c4782b86bc03a36323fd68ad6cc376c6b2ebe57b701cc958ebd6b8d37effd6/,
    );
    assert.match(marks, /import fireworksMarkUrl from '\.\.\/assets\/provider-brands\/fireworks\.svg';/);
    assert.match(marks, /case 'fireworks-ai':\s*return <img src=\{fireworksMarkUrl\} alt="" \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/fireworks\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/fireworks-color\.svg[\s\S]*f1c4782b86bc03a36323fd68ad6cc376c6b2ebe57b701cc958ebd6b8d37effd6/,
    );
  });

  it('vendors the byte-exact upstream GitHub Copilot mark with trademark-aware governance', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(GITHUB_COPILOT_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);
    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      'eeafb3c2f333e04ccf7d031ae215f7adafaed4c6352556b0bf79496e048bcdd7',
    );
    assert.match(marks, /GitHub Copilot mark vendored byte-for-byte from the official Primer Octicons repository:[\s\S]*2ed936e7759451e80ae38b8147cbe2c89de6cc7a[\s\S]*icons\/copilot-24\.svg[\s\S]*eeafb3c2f333e04ccf7d031ae215f7adafaed4c6352556b0bf79496e048bcdd7/);
    assert.match(marks, /case 'github-copilot':\s*return <ProviderAssetMask src=\{githubCopilotBrandMark\} \/>/);
    assert.match(notices, /GitHub Copilot brand mark[\s\S]*2ed936e7759451e80ae38b8147cbe2c89de6cc7a[\s\S]*eeafb3c2f333e04ccf7d031ae215f7adafaed4c6352556b0bf79496e048bcdd7[\s\S]*does not grant rights to GitHub logos/);
  });

  it('vendors and routes byte-exact Xiaomi MiMo and Z.AI provider marks', async () => {
    const [marks, xiaomiMark, zaiMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(XIAOMI_BRAND_MARK_FILE),
      readFile(ZAI_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(xiaomiMark).digest('hex'),
      'b04ad7dad52af2212c4567daf0ee6856f2c4625c92c680a27f9880295d558b71',
      'Xiaomi MiMo must remain byte-identical to @lobehub/icons-static-svg@1.91.0 xiaomimimo.svg',
    );
    assert.equal(
      createHash('sha256').update(zaiMark).digest('hex'),
      'e748cb5108ce37b116d7a5ba97d37e0ae97eadf6849b0de11afb248e244a01e1',
      'Z.AI must remain byte-identical to @lobehub/icons-static-svg@1.91.0 zai.svg',
    );
    assert.match(
      marks,
      /Xiaomi MiMo and Z\.AI marks vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*packages\/static-svg\/icons\/xiaomimimo\.svg[\s\S]*packages\/static-svg\/icons\/zai\.svg[\s\S]*license: MIT/,
    );
    assert.match(
      marks,
      /case 'xiaomi-token-plan-cn':\s*case 'xiaomi-token-plan-sgp':\s*case 'xiaomi-token-plan-ams':\s*case 'xiaomi':\s*return <XiaomiMiMo \/>/,
    );
    assert.match(marks, /case 'zai':\s*case 'zai-coding-plan':\s*return <ZAI \/>/);
  });

  it('keeps the verified Ollama mark and routes it through catalog, detail, and first-run surfaces', async () => {
    const [marks, catalog, providerDialog, onboardingHero, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(PROVIDER_CATALOG_FILE, 'utf8'),
      readFile(PROVIDER_CONNECTION_DIALOG_FILE, 'utf8'),
      readFile(ONBOARDING_HERO_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.match(
      marks,
      /Vendored unchanged from @lobehub\/icons-static-svg@1\.91\.0:[\s\S]*github\.com\/lobehub\/lobe-icons\/blob\/32f4083f7a20b67ecdc7b29c0af031ada5a29c52\/packages\/static-svg\/icons\/ollama\.svg[\s\S]*MIT license/,
      'the Ollama mark must record its repository, package version, commit, file path, license, and unchanged-vendor status',
    );
    const ollamaPath = marks.match(/function Ollama\(\)[\s\S]*?<path d="([^"]+)" \/>/)?.[1];
    assert.ok(ollamaPath, 'the Ollama provider must render its vendored SVG path');
    assert.equal(
      createHash('sha256').update(ollamaPath).digest('hex'),
      'fe847dff4bb6ae25ebec9a7def819ec2583023552b2e88a572c481aad2d32433',
      'the complete Ollama path must remain byte-identical to the pinned Lobe Icons SVG',
    );
    assert.ok(
      notices.includes(
        '`apps/desktop/src/renderer/settings/provider-brand-marks.tsx` `Ollama` path\n' +
          '    - Upstream commit: `32f4083f7a20b67ecdc7b29c0af031ada5a29c52`\n' +
          '    - Upstream path: `packages/static-svg/icons/ollama.svg`\n' +
          '    - SHA-256: `fe847dff4bb6ae25ebec9a7def819ec2583023552b2e88a572c481aad2d32433`',
      ),
      'the shared Lobe Icons notice must inventory the vendored Ollama asset',
    );
    assert.match(
      marks,
      /case 'ollama':\s*case 'ollama-cloud':\s*return <Ollama \/>/,
      'local Ollama and the independent Ollama Cloud identity must reuse the same upstream monochrome mark',
    );
    assert.match(catalog, /<ProviderLogo type=\{props\.type\} \/>/);
    assert.match(
      providerDialog,
      /<DialogHeader[\s\S]*<ProviderLogo type=\{props\.providerType\} compact \/>/,
      'the connection detail header must render the same provider mark as the catalog',
    );
    assert.match(onboardingHero, /<ProviderLogo type=\{type\} compact \/>/);
  });

  it('vendors the unmodified upstream Cerebras mark with traceable provenance', async () => {
    const [marks, notices, cerebrasMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
      readFile(CEREBRAS_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(cerebrasMark).digest('hex'),
      '355c2225284cd06c9cf4246110b60cb21bc86039872981e1be6bb82deec2ffa7',
      'the vendored Cerebras mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 cerebras-color.svg',
    );
    assert.match(
      notices,
      /Repository: https:\/\/github\.com\/lobehub\/lobe-icons[\s\S]*@lobehub\/icons-static-svg` version `1\.91\.0`[\s\S]*apps\/desktop\/src\/renderer\/assets\/provider-brands\/cerebras\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/cerebras-color\.svg[\s\S]*355c2225284cd06c9cf4246110b60cb21bc86039872981e1be6bb82deec2ffa7/,
      'Cerebras provenance must identify the exact package release, upstream revision, path, and license',
    );
    assert.match(
      marks,
      /import cerebrasBrandMark from '\.\.\/assets\/provider-brands\/cerebras\.svg';[\s\S]*case 'cerebras':\s*return <img src=\{cerebrasBrandMark\} alt="" \/>/,
      'the stable Cerebras provider id must preserve the upstream color asset through an img',
    );
    assert.doesNotMatch(marks, /ProviderMaskMark|providerMaskMark/);
  });

  it('vendors and renders the byte-exact upstream Mistral color mark', async () => {
    const [mistralMark, componentSrc, notices] = await Promise.all([
      readFile(MISTRAL_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(mistralMark).digest('hex'),
      '722f74b289d95486b43662fe24fa883b333701296f618406cd0ed502299170b6',
      'the vendored Mistral mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 mistral-color.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/mistral\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/mistral-color\.svg[\s\S]*722f74b289d95486b43662fe24fa883b333701296f618406cd0ed502299170b6/,
      'Mistral must append provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import mistralBrandMark from '\.\.\/assets\/provider-brands\/mistral\.svg';/);
    assert.match(
      componentSrc,
      /Mistral mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/mistral-color\.svg[\s\S]*MIT[\s\S]*722f74b289d95486b43662fe24fa883b333701296f618406cd0ed502299170b6/,
    );
    assert.match(componentSrc, /case 'mistral':\s*return <img src=\{mistralBrandMark\} alt="" \/>/);
  });

  it('vendors and renders the byte-exact upstream Cohere color mark', async () => {
    const [cohereMark, componentSrc, notices] = await Promise.all([
      readFile(COHERE_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(cohereMark).digest('hex'),
      '84d0ee3cbe66f030e5a18cb2c86da9166ab2137c7a98781693bb1fbf31e392b9',
      'the vendored Cohere mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 cohere-color.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/cohere\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/cohere-color\.svg[\s\S]*84d0ee3cbe66f030e5a18cb2c86da9166ab2137c7a98781693bb1fbf31e392b9/,
      'Cohere must append provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import cohereBrandMark from '\.\.\/assets\/provider-brands\/cohere\.svg';/);
    assert.match(
      componentSrc,
      /Cohere mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/cohere-color\.svg[\s\S]*MIT[\s\S]*84d0ee3cbe66f030e5a18cb2c86da9166ab2137c7a98781693bb1fbf31e392b9/,
    );
    assert.match(componentSrc, /case 'cohere':\s*return <img src=\{cohereBrandMark\} alt="" \/>/);
  });

  it('vendors the unmodified upstream NVIDIA mark with traceable provenance', async () => {
    const [marks, notices, nvidiaMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
      readFile(NVIDIA_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(nvidiaMark).digest('hex'),
      '8c941e4eb8b782eccaaea1240c059d20be33ab8eda28d7c9ed9b53ac802fe683',
      'the vendored NVIDIA mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 nvidia-color.svg',
    );
    assert.match(
      notices,
      /Repository: https:\/\/github\.com\/lobehub\/lobe-icons[\s\S]*@lobehub\/icons-static-svg` version `1\.91\.0`[\s\S]*apps\/desktop\/src\/renderer\/assets\/provider-brands\/nvidia\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/nvidia-color\.svg[\s\S]*8c941e4eb8b782eccaaea1240c059d20be33ab8eda28d7c9ed9b53ac802fe683/,
      'NVIDIA provenance must identify the exact package release, upstream revision, path, and license',
    );
    assert.match(
      marks,
      /import nvidiaMarkUrl from '\.\.\/assets\/provider-brands\/nvidia\.svg';[\s\S]*case 'nvidia':\s*return <img src=\{nvidiaMarkUrl\} alt="" \/>/,
      'the stable NVIDIA provider id must preserve the upstream color asset',
    );
    assert.doesNotMatch(marks, /NvidiaMask|nvidiaAssetMask/);
  });

  it('vendors and renders the byte-exact upstream Hunyuan color mark', async () => {
    const [hunyuanMark, componentSrc, notices] = await Promise.all([
      readFile(TENCENT_HUNYUAN_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(hunyuanMark).digest('hex'),
      '510e7bb438506b5aadfaf8b9551d1606efd5b4171161a64a64204c72a453658a',
      'the vendored Hunyuan mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 hunyuan-color.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/hunyuan\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/hunyuan-color\.svg[\s\S]*510e7bb438506b5aadfaf8b9551d1606efd5b4171161a64a64204c72a453658a/,
      'Tencent must append byte-exact Hunyuan provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import hunyuanBrandMark from '\.\.\/assets\/provider-brands\/hunyuan\.svg';/);
    assert.match(
      componentSrc,
      /Hunyuan mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/hunyuan-color\.svg[\s\S]*MIT[\s\S]*510e7bb438506b5aadfaf8b9551d1606efd5b4171161a64a64204c72a453658a/,
    );
    assert.match(componentSrc, /case 'tencent-tokenhub':\s*return <img src=\{hunyuanBrandMark\} alt="" \/>/);
  });

  it('vendors and renders the byte-exact upstream StepFun color mark', async () => {
    const [stepfunMark, componentSrc, notices] = await Promise.all([
      readFile(STEPFUN_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(stepfunMark).digest('hex'),
      'f55afc0e6004c8854f76bd5bbcc0fce9fc0ed9316691d54fb02d088c24fab40d',
      'the vendored StepFun mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 stepfun-color.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/stepfun\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/stepfun-color\.svg[\s\S]*f55afc0e6004c8854f76bd5bbcc0fce9fc0ed9316691d54fb02d088c24fab40d/,
      'StepFun must append byte-exact provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import stepfunBrandMark from '\.\.\/assets\/provider-brands\/stepfun\.svg';/);
    assert.match(
      componentSrc,
      /StepFun mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/stepfun-color\.svg[\s\S]*MIT[\s\S]*f55afc0e6004c8854f76bd5bbcc0fce9fc0ed9316691d54fb02d088c24fab40d/,
    );
    assert.match(componentSrc, /case 'stepfun':\s*return <img src=\{stepfunBrandMark\} alt="" \/>/);
    assert.match(
      componentSrc,
      /case 'stepfun-ai-step-plan':\s*case 'stepfun-step-plan':\s*case 'stepfun-ai':\s*case 'stepfun':\s*return <img src=\{stepfunBrandMark\} alt="" \/>/,
      'catalog and detail must route every StepFun access path through the same shared color mark',
    );
  });

  it('vendors and renders the byte-exact upstream Volcengine color mark', async () => {
    const [volcengineMark, componentSrc, notices] = await Promise.all([
      readFile(VOLCENGINE_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(volcengineMark).digest('hex'),
      '84f9e2cd1da7e73dc6c9a0f2521745d39cae96c008752cdb1baf57a8c94393a1',
      'the vendored Volcengine mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 volcengine-color.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/volcengine\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/volcengine-color\.svg[\s\S]*84f9e2cd1da7e73dc6c9a0f2521745d39cae96c008752cdb1baf57a8c94393a1/,
      'Volcengine must append byte-exact provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import volcengineBrandMark from '\.\.\/assets\/provider-brands\/volcengine\.svg';/);
    assert.match(
      componentSrc,
      /Volcengine mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/volcengine-color\.svg[\s\S]*MIT[\s\S]*84f9e2cd1da7e73dc6c9a0f2521745d39cae96c008752cdb1baf57a8c94393a1/,
    );
    assert.match(
      componentSrc,
      /case 'volcengine-ark':\s*case 'volcengine-coding-plan':\s*return <img src=\{volcengineBrandMark\} alt="" \/>/,
      'direct Ark and Coding Plan must share the single governed Volcengine asset route',
    );
  });

  it('routes Tencent plans through the shared byte-exact Tencent Cloud mark', async () => {
    const [tencentCloudMark, componentSrc, notices] = await Promise.all([
      readFile(TENCENT_CLOUD_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(tencentCloudMark).digest('hex'),
      'f860dae064a3afd24970efd2bc5892f39438526bf52c3a9748f61fc05c1cfd58',
      'the vendored Tencent Cloud mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 tencentcloud-color.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/tencentcloud\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/tencentcloud-color\.svg[\s\S]*f860dae064a3afd24970efd2bc5892f39438526bf52c3a9748f61fc05c1cfd58/,
      'Tencent Coding Plan must append byte-exact Tencent Cloud provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import tencentCloudBrandMark from '\.\.\/assets\/provider-brands\/tencentcloud\.svg';/);
    assert.match(
      componentSrc,
      /Tencent Cloud mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/tencentcloud-color\.svg[\s\S]*MIT[\s\S]*f860dae064a3afd24970efd2bc5892f39438526bf52c3a9748f61fc05c1cfd58/,
    );
    assert.match(
      componentSrc,
      /case 'tencent-coding-plan':\s*case 'tencent-token-plan':\s*return <img src=\{tencentCloudBrandMark\} alt="" \/>/,
    );
  });

  it('ships the Lobe Icons MIT notice beside vendored provider assets', async () => {
    const [desktopPackage, notices] = await Promise.all([
      readFile(DESKTOP_PACKAGE_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.match(notices, /## Lobe Icons/);
    assert.match(notices, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(notices, /@lobehub\/icons-static-svg` version `1\.91\.0`/);
    assert.match(notices, /32f4083f7a20b67ecdc7b29c0af031ada5a29c52/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/xai\.svg[\s\S]*packages\/static-svg\/icons\/xai\.svg[\s\S]*89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451/,
    );
    assert.match(notices, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/lmstudio\.svg[\s\S]*packages\/static-svg\/icons\/lmstudio\.svg[\s\S]*4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b/,
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/cerebras\.svg[\s\S]*packages\/static-svg\/icons\/cerebras-color\.svg[\s\S]*355c2225284cd06c9cf4246110b60cb21bc86039872981e1be6bb82deec2ffa7/,
    );
    assert.match(notices, /MIT License[\s\S]*Copyright \(c\) 2023 LobeHub[\s\S]*Permission is hereby granted/);
    assert.match(notices, /THE SOFTWARE IS PROVIDED "AS IS"/);
    assert.match(
      desktopPackage,
      /"build:renderer": "vite build && node \.\.\/\.\.\/scripts\/check-third-party-notices\.mjs"/,
      'renderer builds must verify that the public notice was copied byte-for-byte into dist-renderer',
    );
  });

  it('vendors and renders the byte-exact Lobe Icons LM Studio SVG', async () => {
    const componentSrc = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');
    const asset = await readFile(LM_STUDIO_BRAND_ASSET_FILE);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b',
      'LM Studio SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0',
    );
    assert.match(componentSrc, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(componentSrc, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(componentSrc, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(componentSrc, /packages\/static-svg\/icons\/lmstudio\.svg/);
    assert.match(componentSrc, /MIT/);
    assert.match(componentSrc, /4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b/);
    assert.match(componentSrc, /import lmStudioBrandMark from '\.\.\/assets\/provider-brands\/lmstudio\.svg';/);
    assert.match(componentSrc, /function ProviderAssetMask\([\s\S]*className="providerAssetMask"[\s\S]*WebkitMaskImage: mask/);
    assert.match(componentSrc, /case 'lm-studio':\s*return <ProviderAssetMask src=\{lmStudioBrandMark\} \/>/);
  });

  it('vendors the byte-exact monochrome ZenMux SVG through the shared mask and notice seams', async () => {
    const [componentSrc, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(ZENMUX_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '1f9fab4e48601ca583e44ff06f22040a8b40f8952bc6bd67e67b065bef00b4b5',
      'ZenMux SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 zenmux.svg',
    );
    assert.match(componentSrc, /import zenmuxBrandMark from '\.\.\/assets\/provider-brands\/zenmux\.svg';/);
    assert.match(
      componentSrc,
      /ZenMux mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/zenmux\.svg[\s\S]*no upstream color variant[\s\S]*MIT[\s\S]*1f9fab4e48601ca583e44ff06f22040a8b40f8952bc6bd67e67b065bef00b4b5/,
    );
    assert.match(componentSrc, /case 'zenmux':\s*return <ProviderAssetMask src=\{zenmuxBrandMark\} \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/zenmux\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/zenmux\.svg[\s\S]*1f9fab4e48601ca583e44ff06f22040a8b40f8952bc6bd67e67b065bef00b4b5/,
    );
  });

  it('vendors and renders the byte-exact official LocalAI SVG', async () => {
    const [componentSrc, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(LOCALAI_BRAND_ASSET_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '1349c022f30a58836e9b09591031f25bf4ff6bb8627bb50691a46a1c8a512c39',
      'LocalAI SVG must remain byte-identical to the official LocalAI repository',
    );
    assert.match(componentSrc, /import localAiBrandMark from '\.\.\/assets\/provider-brands\/localai\.svg';/);
    assert.match(componentSrc, /case 'localai':\s*return <img src=\{localAiBrandMark\} alt="" \/>/);
    assert.match(
      notices,
      /## LocalAI[\s\S]*mudler\/LocalAI[\s\S]*MIT[\s\S]*b10e330590766ea621c0b03401e77a0589558e76[\s\S]*docs\/assets\/images\/logos\/logo\.svg[\s\S]*1349c022f30a58836e9b09591031f25bf4ff6bb8627bb50691a46a1c8a512c39/,
    );
  });

  it('vendors one byte-exact upstream OpenCode mark for both plans', async () => {
    const [componentSrc, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(OPENCODE_BRAND_ASSET_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '7cfa6e9d6726f7c9fa26c7d9aef0dfec52d20a137380454340f30f12ccbfd302',
      'OpenCode SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 opencode.svg',
    );
    assert.match(componentSrc, /import opencodeBrandMark from '\.\.\/assets\/provider-brands\/opencode\.svg';/);
    assert.match(
      componentSrc,
      /case 'opencode':\s*case 'opencode-go':\s*return <ProviderAssetMask src=\{opencodeBrandMark\} \/>/,
      'Zen and Go must share the single upstream monochrome mark through the governed currentColor seam',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/opencode\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/opencode\.svg[\s\S]*7cfa6e9d6726f7c9fa26c7d9aef0dfec52d20a137380454340f30f12ccbfd302/,
    );
    assert.match(notices, /OpenCode name and logo remain trademarks of their owner/);
  });

  it('preserves every governed color-capable asset while keeping monochrome assets theme-aware', async () => {
    const componentSrc = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');
    const colorAssetBindings = [
      'cerebrasBrandMark',
      'cloudflareMarkUrl',
      'cohereBrandMark',
      'deepinfraBrandMark',
      'fireworksMarkUrl',
      'huggingfaceBrandMark',
      'hunyuanBrandMark',
      'localAiBrandMark',
      'mistralBrandMark',
      'nvidiaMarkUrl',
      'openrouterBrandMark',
      'stepfunBrandMark',
      'tencentCloudBrandMark',
      'togetherBrandMark',
      'volcengineBrandMark',
    ];

    for (const binding of colorAssetBindings) {
      assert.match(componentSrc, new RegExp(`<img src=\\{${binding}\\} alt="" \\/>`), `${binding} must render as an img`);
      assert.doesNotMatch(
        componentSrc,
        new RegExp(`<ProviderAssetMask src=\\{${binding}\\} \\/>`),
        `${binding} must not be flattened into currentColor`,
      );
    }

    for (const binding of ['xaiMarkUrl', 'vercelBrandMark', 'lmStudioBrandMark', 'opencodeBrandMark', 'groqBrandMark']) {
      assert.match(
        componentSrc,
        new RegExp(`<ProviderAssetMask src=\\{${binding}\\} \\/>`),
        `${binding} must remain theme-aware because upstream has no color variant`,
      );
    }
    assert.match(componentSrc, /function Ollama\(\)[\s\S]*fill="currentColor"/);
  });

  it('renders a registered brand mark for every catalog provider (no generic fallback)', async () => {
    // Data-driven completeness so a new catalog provider is caught automatically:
    // ProviderBrandMark falls through to <GenericProviderMark /> for any type
    // without an explicit case, which would ship an unbranded placeholder in the
    // catalog and detail surfaces. Core cannot import this renderer module, so
    // this completeness invariant lives here beside the per-mark provenance tests
    // rather than in packages/core's provider-catalog-contract.test.ts.
    const src = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');
    const missing = CATALOG_PROVIDER_TYPES.filter(
      (type) => !new RegExp(`case '${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':`).test(src),
    );
    assert.deepEqual(
      missing,
      [],
      'every catalog provider must resolve to a real brand mark in ProviderBrandMark, not the generic '
        + `fallback — add a switch arm for:\n  ${missing.join('\n  ')}`,
    );
  });
});
