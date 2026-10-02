/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Design System/Tokens — the token layer made visible: color, type, spacing,
 * radius and borders, elevation and layers.
 *
 * Palette Matrix's header records why the earlier token tables were cut: a
 * hand-kept list of var names drifts from the source and carries little review
 * value. These pages avoid both failures by construction.
 *
 * - Names are DISCOVERED, not listed. Every page scans the loaded stylesheets
 *   for custom properties that apply to the story root, so a token added to
 *   maka-tokens.css or the Astryx theme appears here, and a removed one
 *   disappears, with no edit to this file.
 * - Values are READ BACK from what renders, never restated. A color is painted
 *   and its computed color read; a text role renders real text and its
 *   computed size/weight/line-height is read. Tokens are recipes
 *   (`light-dark()`, `oklch(from …)`), so their source text is not the value.
 *   The toolbar's mode and palette switches therefore update every number.
 * - The few names these pages DO spell out are the roles DESIGN.md names
 *   (the surface ladder, the two ink tiers, the three border strengths…).
 *   Those are checked, not trusted: a role DESIGN.md names that the stylesheet
 *   does not define renders as a "Missing" row, so the page doubles as a
 *   doc-versus-source check.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design System/Tokens',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/* ---- discovery ----------------------------------------------------------- */

/** Custom-property names declared by rules that match `el` or an ancestor. */
function discoverTokens(el: Element): string[] {
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        let applies = false;
        try {
          applies = chain.some((node) => node.matches(rule.selectorText));
        } catch {
          applies = false;
        }
        if (applies) {
          for (const prop of Array.from(rule.style)) if (prop.startsWith('--')) names.add(prop);
        }
      }
      if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // Cross-origin sheets (web fonts) are unreadable and hold no tokens.
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Re-run `measure` after mount and whenever the toolbar flips mode/palette. */
function useMeasured<T>(measure: (root: HTMLElement) => T): [RefObject<HTMLDivElement | null>, T | undefined] {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<T>();
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const run = () => setValue(measure(root));
    run();
    const observer = new MutationObserver(() => requestAnimationFrame(run));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-maka-theme', 'style'] });
    return () => observer.disconnect();
    // `measure` is a module-level function per page, so it never changes identity.
  }, [measure]);
  return [ref, value];
}

function isDefined(root: Element, name: string): boolean {
  return getComputedStyle(root).getPropertyValue(name).trim() !== '';
}

/** Paint a probe with `background: var(name)` and read the color that resolved. */
function resolvedColor(root: HTMLElement, name: string): string {
  const probe = document.createElement('span');
  probe.style.background = `var(${name})`;
  root.appendChild(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

/** sRGB bytes of any CSS color, via canvas (which resolves oklch for us). */
function toRgb(color: string): [number, number, number, number] | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a];
}

function contrast(fg: string, bg: string): number | undefined {
  const a = toRgb(fg);
  const b = toRgb(bg);
  if (!a || !b) return undefined;
  const lum = ([r, g, bl]: [number, number, number, number]) => {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function pxOf(root: HTMLElement, cssLength: string): number {
  const probe = document.createElement('div');
  probe.style.width = cssLength;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  root.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/* ---- page chrome --------------------------------------------------------- */

const text = {
  title: { font: 'var(--maka-text-heading-1)', margin: 0 } satisfies CSSProperties,
  section: { font: 'var(--maka-text-heading-3)', margin: 0 } satisfies CSSProperties,
  lede: { font: 'var(--maka-text-body)', color: 'var(--muted-foreground)', margin: 0 } satisfies CSSProperties,
  meta: { font: 'var(--maka-text-supporting)', color: 'var(--muted-foreground)' } satisfies CSSProperties,
  code: { font: 'var(--maka-text-code)', fontSize: '12px' } satisfies CSSProperties,
};

function Page(props: { title: string; lede: ReactNode; children: ReactNode; pageRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={props.pageRef} style={{ display: 'grid', gap: 'var(--space-8)', maxWidth: 960, color: 'var(--foreground)' }}>
      <header style={{ display: 'grid', gap: 'var(--space-1-5)' }}>
        <h1 style={text.title}>{props.title}</h1>
        <p style={text.lede}>{props.lede}</p>
        <p style={text.meta}>Values are read live from what renders. Switch light/dark or the palette in the toolbar and they update.</p>
      </header>
      {props.children}
    </div>
  );
}

function Section(props: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div style={{ display: 'grid', gap: 'var(--space-0-5)' }}>
        <h2 style={text.section}>{props.title}</h2>
        {props.note ? <p style={{ ...text.meta, margin: 0 }}>{props.note}</p> : null}
      </div>
      {props.children}
    </section>
  );
}

function Missing(props: { name: string }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', ...text.meta, color: 'var(--destructive)' }}>
      <code style={text.code}>{props.name}</code>
      <span>Missing: DESIGN.md names this token, but no loaded stylesheet defines it</span>
    </div>
  );
}

const tableCell: CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
  borderBlockEnd: 'var(--border-width-hairline) solid var(--border-soft)',
  textAlign: 'start',
  verticalAlign: 'middle',
};

/* ---- Color --------------------------------------------------------------- */

const COLOR_GROUPS: Array<{ title: string; note: string; tokens: Array<[string, string]>; ink?: boolean }> = [
  {
    title: 'Surfaces',
    note: 'DESIGN.md §2: height maps to lightness, and reading surfaces sit on the brightest tier. --background is the card fill, not the page color.',
    tokens: [
      ['--surface-sunken', 'Sunken: recessed chrome inside a plate'],
      ['--surface-base', 'Base: shell floor behind the sidebar and canvas'],
      ['--surface-raised', 'Raised: cards, content plates, reading surfaces'],
      ['--surface-overlay', 'Overlay: menus, popovers, dialogs, toasts'],
      ['--background', 'Card fill (the ladder is derived from it)'],
      ['--surface-paper', 'Paper: content whose contrast is not ours (HTML preview, PDF, QR codes)'],
    ],
  },
  {
    title: 'Ink',
    note: 'DESIGN.md §3: prose has exactly two tiers. Contrast is measured against --background; AA needs 4.5 or more.',
    ink: true,
    tokens: [
      ['--foreground', 'Primary text'],
      ['--muted-foreground', 'Secondary text'],
      ['--color-text-disabled', 'Disabled (deliberately below AA, see §3)'],
    ],
  },
  {
    title: 'Accent',
    note: 'DESIGN.md §8: the accent follows the palette and only signals interaction or state. The brand mark is fixed and is never a CTA color.',
    tokens: [
      ['--accent', 'Interaction: focus, selection, live state'],
      ['--accent-solid', 'Solid: links and accent-colored text'],
      ['--color-accent-muted', 'Accent tint (0.24 alpha)'],
      ['--maka-brand', 'Brand mark (fixed)'],
    ],
  },
  {
    title: 'Status',
    note: 'DESIGN.md §8: success, warning and error only; there is no info color. Tinted surfaces use only the Astryx *-muted tokens.',
    tokens: [
      ['--success', 'Success'],
      ['--warning', 'Warning'],
      ['--destructive', 'Error / destructive'],
      ['--color-success-muted', 'Success tint'],
      ['--color-warning-muted', 'Warning tint'],
      ['--color-error-muted', 'Error tint'],
    ],
  },
  {
    title: 'Interaction states',
    note: 'DESIGN.md §9: hover washes come in two lanes; product rows and controls use --state-hover-bg.',
    tokens: [
      ['--state-hover-bg', 'Hover wash'],
      ['--state-selected-bg', 'Selected wash'],
      ['--focus-ring', 'Keyboard focus ring'],
    ],
  },
];

function measureColors(root: HTMLElement) {
  const background = resolvedColor(root, '--background');
  return COLOR_GROUPS.map((group) => ({
    ...group,
    rows: group.tokens.map(([name, role]) => {
      if (!isDefined(root, name)) return { name, role, missing: true as const };
      const color = resolvedColor(root, name);
      return { name, role, missing: false as const, color, ratio: group.ink ? contrast(color, background) : undefined };
    }),
  }));
}

function ColorPage() {
  const [ref, groups] = useMeasured(measureColors);
  return (
    <Page pageRef={ref} title="Color" lede="Grouped by the roles in DESIGN.md. Each swatch is the rendered color; the value on the right is what the browser resolved.">
      {groups?.map((group) => (
        <Section key={group.title} title={group.title} note={group.note}>
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {group.rows.map((row) =>
              row.missing ? (
                <Missing key={row.name} name={row.name} />
              ) : (
                <div key={row.name} style={{ display: 'grid', gridTemplateColumns: '48px minmax(0, 220px) minmax(0, 1fr) auto', gap: 'var(--space-3)', alignItems: 'center' }}>
                  <div style={{ width: 48, height: 32, borderRadius: 'var(--radius-control)', background: `var(${row.name})`, boxShadow: 'inset 0 0 0 1px var(--border)' }} />
                  <code style={text.code}>{row.name}</code>
                  <span style={{ font: 'var(--maka-text-body)' }}>{row.role}</span>
                  <span style={{ ...text.meta, fontVariantNumeric: 'tabular-nums', textAlign: 'end' }}>
                    {row.ratio !== undefined ? (
                      <span style={{ marginInlineEnd: 'var(--space-2)', color: row.ratio >= 4.5 ? 'var(--foreground)' : 'var(--destructive)' }}>
                        Contrast {row.ratio.toFixed(2)}
                      </span>
                    ) : null}
                    <code style={text.code}>{row.color}</code>
                  </span>
                </div>
              ),
            )}
          </div>
        </Section>
      ))}
    </Page>
  );
}

/* ---- Typography ---------------------------------------------------------- */

const DESIGN_TEXT_ROLES: Array<[string, string]> = [
  ['display-1', 'Rare large statements, empty-state anchors'],
  ['display-2', 'Rare large statements'],
  ['display-3', 'Rare large statements'],
  ['heading-1', 'Page title'],
  ['heading-2', 'Panel title'],
  ['heading-3', 'Section title'],
  ['heading-4', 'Compact titles, setting names'],
  ['heading-5', 'Smallest heading'],
  ['body', 'Body text, conversation'],
  ['label', 'Controls and interactive labels'],
  ['supporting', 'Metadata, helper text'],
  ['code', 'Code, paths, commands, identifiers'],
  ['badge-label', 'Badge text'],
];

const SAMPLE = '设置 Settings 1234';

function measureType(root: HTMLElement) {
  const discovered = discoverTokens(root).filter((name) => name.startsWith('--maka-text-'));
  const roleNames = new Set([...discovered.map((n) => n.replace('--maka-text-', '')), ...DESIGN_TEXT_ROLES.map(([r]) => r)]);
  const usage = new Map(DESIGN_TEXT_ROLES);
  // Order by the role's own size token; the numbers shown come from the
  // rendered sample cell (RoleRow), not from this sort key.
  const sizeOf = (role: string) => (isDefined(root, `--text-${role}-size`) ? pxOf(root, `var(--text-${role}-size)`) : 0);
  return [...roleNames]
    .map((role) => {
      const name = `--maka-text-${role}`;
      return { role, name, usage: usage.get(role), missing: !isDefined(root, name), order: sizeOf(role) };
    })
    .sort((a, b) => Number(a.missing) - Number(b.missing) || b.order - a.order || a.role.localeCompare(b.role, 'en', { numeric: true }));
}

/** One role: renders the sample, then reads the metrics off that very cell. */
function RoleRow(props: { role: string; name: string; usage?: string }) {
  const sampleRef = useRef<HTMLTableCellElement>(null);
  const [metrics, setMetrics] = useState<{ size: number; weight: string; lineHeight: number }>();
  useLayoutEffect(() => {
    const cell = sampleRef.current;
    if (!cell) return;
    const run = () => {
      const s = getComputedStyle(cell);
      setMetrics({ size: parseFloat(s.fontSize), weight: s.fontWeight, lineHeight: Math.round(parseFloat(s.lineHeight) * 10) / 10 });
    };
    run();
    const observer = new MutationObserver(() => requestAnimationFrame(run));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-maka-theme', 'style'] });
    return () => observer.disconnect();
  }, []);
  return (
    <tr>
      <td ref={sampleRef} style={{ ...tableCell, font: `var(${props.name})`, whiteSpace: 'nowrap' }}>
        {SAMPLE}
      </td>
      <td style={tableCell}>
        <code style={text.code}>{props.role}</code>
      </td>
      <td style={{ ...tableCell, ...text.meta, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {metrics ? (
          <>
            {metrics.size}px / {metrics.weight} / {metrics.lineHeight}px
            {metrics.lineHeight % 4 !== 0 ? <span style={{ color: 'var(--warning)' }}> (off the 4px grid)</span> : null}
          </>
        ) : null}
      </td>
      <td style={{ ...tableCell, font: 'var(--maka-text-body)' }}>{props.usage ?? <span style={text.meta}>Not described in DESIGN.md</span>}</td>
    </tr>
  );
}

function TypographyPage() {
  const [ref, rows] = useMeasured(measureType);
  return (
    <Page
      pageRef={ref}
      title="Typography"
      lede="Text roles (--maka-text-*), largest first. DESIGN.md §7: pick a role; never set size, weight or line height at a call site."
    >
      <Section title="Text roles" note="Line heights should land on the 4px grid. Usage comes from DESIGN.md §7.">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={text.meta}>
                <th style={tableCell}>Sample</th>
                <th style={tableCell}>Role</th>
                <th style={tableCell}>Size / weight / line height</th>
                <th style={tableCell}>Usage</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((row) =>
                row.missing ? (
                  <tr key={row.role}>
                    <td style={tableCell} colSpan={4}>
                      <Missing name={row.name} />
                    </td>
                  </tr>
                ) : (
                  <RoleRow key={row.role} role={row.role} name={row.name} usage={row.usage} />
                ),
              )}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Two ink tiers" note="A setting name over its helper line. Hierarchy comes from size and weight, never a third grey.">
        <div style={{ display: 'grid', gap: 'var(--space-1)', padding: 'var(--space-4)', background: 'var(--background)', borderRadius: 'var(--radius-surface)', boxShadow: 'var(--ring-soft)' }}>
          <span style={{ font: 'var(--maka-text-heading-4)' }}>隐身模式</span>
          <span style={{ font: 'var(--maka-text-supporting)', color: 'var(--muted-foreground)' }}>开启后暂停本地记忆读写、联网搜索和定时任务触发。</span>
        </div>
      </Section>
    </Page>
  );
}

/* ---- Spacing ------------------------------------------------------------- */

function measureSpacing(root: HTMLElement) {
  return discoverTokens(root)
    .filter((name) => /^--space-[\d-]+$/.test(name))
    .map((name) => ({ name, px: Math.round(pxOf(root, `var(${name})`) * 10) / 10 }))
    .sort((a, b) => a.px - b.px);
}

function SpacingPage() {
  const [ref, rows] = useMeasured(measureSpacing);
  return (
    <Page pageRef={ref} title="Spacing" lede="One ruler (--space-*) for every padding, gap and margin, on a 4px base.">
      <Section title="Scale" note="Each bar is drawn at the token's actual width.">
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          {rows?.map((row) => (
            <div key={row.name} style={{ display: 'grid', gridTemplateColumns: '120px 56px minmax(0, 1fr)', gap: 'var(--space-3)', alignItems: 'center' }}>
              <code style={text.code}>{row.name}</code>
              <span style={{ ...text.meta, fontVariantNumeric: 'tabular-nums', textAlign: 'end' }}>{row.px}px</span>
              <div style={{ height: 12, width: `var(${row.name})`, background: 'var(--accent)', borderRadius: 2 }} />
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}

/* ---- Radius & borders ---------------------------------------------------- */

function measureShape(root: HTMLElement) {
  const tokens = discoverTokens(root);
  const radius = tokens
    .filter((name) => name.startsWith('--radius-'))
    .map((name) => {
      const raw = getComputedStyle(root).getPropertyValue(name).trim();
      return { name, raw, px: raw.endsWith('%') ? undefined : Math.round(pxOf(root, `var(${name})`) * 10) / 10 };
    })
    .sort((a, b) => (a.px ?? 1e9) - (b.px ?? 1e9) || a.name.localeCompare(b.name));
  const borders = ['--border-soft', '--border', '--border-strong'].map((name) => ({ name, missing: !isDefined(root, name) }));
  return { radius, borders, ringSoft: isDefined(root, '--ring-soft') };
}

function ShapePage() {
  const [ref, data] = useMeasured(measureShape);
  return (
    <Page pageRef={ref} title="Radius and borders" lede="DESIGN.md §4 and §6: radius is assigned by box height; borders come in three strengths, and one edge gets one separator.">
      <Section title="Radius" note="Maka and Astryx names resolve to the same ladder (control = inner = 6px). The percentage rung is for square icon plates.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-4)' }}>
          {data?.radius.map((row) => (
            <div key={row.name} style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
              <div style={{ width: 72, height: 48, borderRadius: `var(${row.name})`, background: 'var(--background)', boxShadow: 'inset 0 0 0 1px var(--border-strong)' }} />
              <code style={text.code}>{row.name}</code>
              <span style={text.meta}>{row.px !== undefined ? `${row.px}px` : row.raw}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Border strengths" note="soft: quiet separation inside a plate. default: structural boundaries between regions. strong: selected and active emphasis.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
          {data?.borders.map((row) =>
            row.missing ? (
              <Missing key={row.name} name={row.name} />
            ) : (
              <div key={row.name} style={{ display: 'grid', gap: 'var(--space-2)' }}>
                <div style={{ height: 56, borderRadius: 'var(--radius-surface)', background: 'var(--background)', border: `var(--border-width-hairline) solid var(${row.name})` }} />
                <code style={text.code}>{row.name}</code>
              </div>
            ),
          )}
          {data?.ringSoft ? (
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={{ height: 56, borderRadius: 'var(--radius-surface)', background: 'var(--background)', boxShadow: 'var(--ring-soft)' }} />
              <code style={text.code}>--ring-soft</code>
            </div>
          ) : (
            <Missing name="--ring-soft" />
          )}
        </div>
      </Section>
    </Page>
  );
}

/* ---- Elevation & layers -------------------------------------------------- */

function measureDepth(root: HTMLElement) {
  const tokens = discoverTokens(root);
  const elevation = ['--elevation-raised', '--elevation-overlay', '--elevation-drag'].map((name) => ({ name, missing: !isDefined(root, name) }));
  const layers = tokens
    .filter((name) => name.startsWith('--z-'))
    .map((name) => ({ name, value: Number.parseFloat(getComputedStyle(root).getPropertyValue(name)) }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => a.value - b.value);
  return { elevation, layers };
}

function DepthPage() {
  const [ref, data] = useMeasured(measureDepth);
  return (
    <Page pageRef={ref} title="Elevation and layers" lede="DESIGN.md §5: surfaces are flat by default; only what genuinely floats casts a shadow. Dark mode relies on tone and rings before shadow.">
      <Section title="Elevation (named by job)" note="The floating recipe: --surface-overlay fill + --border-soft ring + --elevation-overlay + container radius.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-6)', padding: 'var(--space-6)', background: 'var(--surface-base)', borderRadius: 'var(--radius-modal)' }}>
          {data?.elevation.map((row) =>
            row.missing ? (
              <Missing key={row.name} name={row.name} />
            ) : (
              <div key={row.name} style={{ display: 'grid', gap: 'var(--space-2)' }}>
                <div style={{ height: 72, borderRadius: 'var(--radius-surface)', background: 'var(--surface-overlay)', boxShadow: `var(${row.name})` }} />
                <code style={text.code}>{row.name}</code>
              </div>
            ),
          )}
        </div>
      </Section>
      <Section title="Layers (z-index)" note="Lowest first. A new floating surface picks an existing layer; never a bare number.">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 320 }}>
            <tbody>
              {data?.layers.map((row) => (
                <tr key={row.name}>
                  <td style={tableCell}>
                    <code style={text.code}>{row.name}</code>
                  </td>
                  <td style={{ ...tableCell, ...text.meta, fontVariantNumeric: 'tabular-nums', textAlign: 'end' }}>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}

export const Color: Story = { name: 'Color', render: () => <ColorPage /> };
export const Typography: Story = { name: 'Typography', render: () => <TypographyPage /> };
export const Spacing: Story = { name: 'Spacing', render: () => <SpacingPage /> };
export const RadiusAndBorders: Story = { name: 'Radius and borders', render: () => <ShapePage /> };
export const ElevationAndLayers: Story = { name: 'Elevation and layers', render: () => <DepthPage /> };
