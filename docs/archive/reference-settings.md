<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Reference Settings — full reverse-engineer (2026-06-23)

> Archived on 2026-07-13. This reverse-engineering snapshot is provenance, not the current Settings contract.

Cross-checked by 4 parallel Explore agents on the extracted bundle at
`/tmp/qoder-asar/out/renderer/assets/`.

This note captures the reference's Settings module so future Maka PRs can
align without re-doing the dig. Naming hygiene applies: do not surface
the reference product name in code, commits, or end-user copy.

---

## 1. Shell shape

Settings is a **full-pane modal** that takes over the workspace area. It
is NOT a small overlay sheet.

- `role="dialog"` + `aria-modal="true"`
- Marker attributes: `data-modal="agents-settings"`,
  `data-canvas-dialog="true"`, `data-settings-layout="page"`
- Outer shell:
  ```
  flex h-full min-h-0 w-full flex-col overflow-hidden bg-background select-none
  ```
- The rest of the chat surface stays visible behind a subtle backdrop;
  the modal does not float over a blurred mask — it occupies the canvas.

### Two-rail layout

| Region   | Width / sizing                       | Notes                                    |
|----------|--------------------------------------|------------------------------------------|
| Nav rail | `w-[256px] shrink-0`                 | Left side, `bg-transparent`, full height |
| Content  | `flex-1 min-w-0 overflow-hidden`     | Right side, scrolls on the inner column  |
| Gap      | `var(--agents-content-area-gap)` 4px | Margin between rail and content plate    |

Content pane class: `agents-settings-wide-content`:
```css
.agents-settings-wide-content {
  background: var(--agents-content-area-bg);
  margin: var(--agents-content-area-gap)
          var(--agents-content-area-gap)
          var(--agents-content-area-gap) 0;
  border-radius: var(--agents-content-area-radius); /* 6px */
}
```

Content body inner wrapper (where the page lives):
```
mx-auto min-h-[200px] max-w-3xl pb-16 pt-10
```
`max-w-3xl` = 48rem / 768px. That's the optical reading column for any
settings page body.

### Responsive

| Breakpoint | Behavior                                              |
|------------|-------------------------------------------------------|
| ≥ 1200px   | Two-rail (256px rail + content)                       |
| 900–1199   | Two-rail, tightened                                   |
| < 900px    | Compact: rail collapses; header shows back-arrow + title |

---

## 2. Nav rail

The rail is a flat vertical list (no group headings — purely flat).

### Items shown to the end user (in order)

1. `preferences` — **Preferences** (the big aggregator)
2. `profile` — Profile / account
3. `system` — **System** (intentionally near-empty placeholder)
4. `keyboard` — Keyboard shortcuts
5. `vm` — Secure workspace / VM mode
6. `experimental` — Experimental flags
7. `permissions` — System capability toggles
8. `connector` — Integrations / connectors
9. `appshot` — App snapshot (macOS only, gated by `platforms: ["darwin"]`)

### Hidden / dev-only tabs

`appearance` (handled via the Preferences page itself), `privacy`,
`debug`, `hiddenConnector`, `awareness`, `appUpdate`, `models`,
`customModels`, `commands`, `agents`, `worktrees`, `quickpick`,
`voiceInput`, `wechat`, `beta`, `channels`, `legokit`, `archived` — all
`exposed: false`.

Tab registry lives in `index-C02cm0ok.js` around offset ~213400 (look
for `Su=[]`).

### Nav-row recipe

```html
<!-- inactive -->
<button class="squircle-md text-text-secondary/80
               hover:bg-[var(--settings-nav-row-selected-bg)]
               hover:text-text/80">
  <Icon size=… />
  <span>Label</span>
</button>

<!-- active -->
<button class="squircle-md
               bg-[var(--settings-nav-row-selected-bg)]
               text-text/80">
  …
</button>
```

- Icon library: Lucide
- Active state is a **fill** (not border / left-bar), with
  `--settings-nav-row-selected-bg` = `var(--color-fill-secondary)`
- Typography: text-sm (14px), normal weight at rest; no weight bump on
  active (color/background carry the state)
- Padding (educated from sibling rows): `px-4 py-3`
- Gap between glyph + label: `gap-3`
- Border radius: `squircle-md` (custom corner, not pure rounded-md)

---

## 3. Per-tab content inventory

### 3.1 Preferences (the kitchen sink)

Globals offset ~76380–80000. This single tab carries the bulk of the
end-user controls:

| Control                          | Type            | Notes                                                       |
|----------------------------------|-----------------|-------------------------------------------------------------|
| Language                         | select          | UI locale                                                   |
| Extended Thinking                | switch          | Bigger reasoning budget, disables streaming                 |
| Launch at Login (autoLaunch)     | switch          | Auto-start                                                  |
| Close Window Behavior            | radio / select  | Ask / Minimize-to-tray / Quit                               |
| Desktop Notifications            | switch          | Native OS notifications                                     |
| Sound Notifications              | switch          | Audio on task completion                                    |
| Include Co-Authored-By           | switch          | Adds `Co-authored-by:` trailer to git commits               |
| Quick Switch (Ctrl/Cmd+Tab)      | radio           | Workspaces vs Agents                                        |
| Auto-advance after archive       | radio           | Next / Prev / Close                                         |
| Default Mode (new agent)         | radio           | Agent / Plan                                                |
| Preview Mode (artifactPreview)   | radio           | New window / Right sidebar                                  |
| Expand tool calls by default     | switch          | Tool-block collapsed vs expanded                            |
| Show tool steps in IM channels   | switch          | Whether bot-reply surfaces include tool-call sub-steps      |
| Tool execution limit             | number input    | Soft pause when one turn exceeds N tool calls               |
| Keep System Awake (preventSleep) | switch          | While Agent works                                           |
| Network Proxy                    | proxy block     | System / Manual; URL input + test button + scheme validation |
| Chat Settings (sub-section)      | composite       | Theme brightness, interface style, glass effects, font face, font size, chat width |

**Key insight**: reference does NOT split "system-level" toggles
(autoLaunch / preventSleep / notifications / proxy / closeWindowAction)
into a separate System tab. They live alongside chat/agent toggles in
ONE long Preferences page.

### 3.2 System

Title only. No fields. Placeholder for future use. The page exists in
the nav but its body is intentionally empty / "to be defined." Confirmed
by walking the bundle.

### 3.3 Profile

Two sections:
- **Avatar**: glyph (first char or emoji) + background color (preset
  palette of ~11 tones)
- **Account & Subscription**: email (copy), Account UID (copy),
  product UUID (copy), subscription tier (read-only), pricing-page link,
  logout

### 3.4 Appearance (`appearance` i18n key — actually rendered inside
Preferences in production)

| Control                  | Type     | Options                                                         |
|--------------------------|----------|-----------------------------------------------------------------|
| Interface theme          | select   | System pref / Light / Dark / Light Glass / Light Clear (win) / Dark Glass / Dark Clear (win) / Classic Dark / Parchment Light / Parchment Dark / From editors |
| Light variant            | select   | Per-mode theme                                                  |
| Dark variant             | select   | Per-mode theme                                                  |
| Workspace icon in sidebar| switch   | Project glyph in the sidebar workspace list                     |
| Always expand to-do list | switch   | Full vs compact to-do view                                      |

### 3.5 Keyboard

- Search field across all shortcuts
- Per-action row with primary + alternative binding
- "Reset all to defaults"
- Categories: General / Chats (workspaces) / Agents
  - General: Show shortcuts / Open settings / Toggle sidebar / Undo archive
  - Chats: Quick switch
  - Agents: Create new task / Search all tasks / Search in current task /
    Prev tab / Next tab / Focus input / Toggle input focus / Send / New line

### 3.6 VM (Secure workspace)

Brief description: "dedicated space on your computer for running tasks
— faster, more reliable, on-device." Enable/disable toggle.

### 3.7 Experimental

Beta feature toggles. Per-flag rows; roster managed in the renderer
component, not visible as a literal array in the bundle.

### 3.8 Permissions

"System permissions QoderWork needs on this Mac." Capability rows
(filesystem / network / mic / screen recording / accessibility) with
"granted / not granted" status and a "request" CTA.

### 3.9 Connector

Integrations with external apps. Builtin connectors / market connectors
/ custom connectors. Each row: brand glyph, status, enable toggle,
"configure" button.

### 3.10 App Snapshot

macOS-only. Frontmost-app screenshot capture for chat context. Needs
Accessibility + Screen Recording perms. Permission status row + capture
preview.

---

## 4. Repeating visual patterns inside a page

Reference does NOT use bordered card containers around groups of
controls. The default presentation is a **flat row list inside the
`max-w-3xl` column**.

### 4.0 Content-column padding — WAWQAQ msg `2c810f2d` 2026-06-23

WAWQAQ called out the left/right whitespace as visibly wider in
reference than in Maka. Concrete numbers from a second RE pass:

- The content column is `mx-auto max-w-3xl pt-10 pb-16` (= 768px wide,
  40px top, 64px bottom). No explicit `px-N` is applied inside the
  column — the side whitespace comes from the column NOT filling the
  right pane.
- At the typical desktop window width (~1280px viewport, 256px nav
  rail), the right pane is ~1024px. A 768px centered column leaves
  ~128px of whitespace on each side. That's the "wider padding" effect.
- Inside each row, padding is `px-5 py-4` (20px / 16px). Rows do NOT
  carry their own border, background plate, or shadow — separation is
  pure spacing.

**Maka delta found 2026-06-23**:
- `.settingsStructuredPage` had `gap: 16px` but NO `max-width` / `margin: 0 auto` — rows stretched to fill the right pane. Fixed to `max-width: 768px; margin: 0 auto; padding: 40px 24px 64px`.
- `.settingsFormRow` had `border-bottom: 1px solid var(--border)` and `padding: 6px 0` — both wrong. Reference uses spacing-only and `px-5 py-4`. Fixed to `padding: 16px 20px`, no border-bottom.
- `.settingsRow` was sharing `.providerCard` chrome (bordered, tinted, lifted). Provider cards keep their chrome (they ARE cards); `.settingsRow` flattened to a flex row.
- Label was 12px / 600 weight; bumped to 14px / 500. Sub-text 11px → 12px. Matches reference `text-sm font-medium` + `text-xs text-text-quaternary`.

### 4.1 Row

```
flex items-center gap-3 px-4 py-3   /* group */
  ├── label column
  │   ├── truncate text-sm font-medium text-text     (title)
  │   └── mt-0.5 truncate text-xs text-text-quaternary (hint)
  └── control (right-aligned)
```

- No border / no card background per row by default
- Visual separation between rows is achieved by spacing alone (no
  border-bottom)
- Hover state moves via the parent `.group` (e.g., shows a kebab menu)

### 4.2 Sub-section heading inside a tab

```
text-sm font-semibold text-text
mb-4
```

### 4.3 Switch

- ~20×20px wrapper, `rounded-md`
- On: `bg-primary/20 ring-1 ring-primary/40 scale-[0.97]`
- Off: subtle gray fill (`bg-gray-100 dark:bg-neutral-600`) with inset shadow
- Transition: `transition-all duration-200`

### 4.4 Input

```
w-full px-3 py-2 text-sm bg-background border rounded-md
border-border-tertiary/80
focus:outline-none focus:ring-2 focus:ring-primary/50
```
- Error: `border-error-border`
- Password / icon suffix: `pr-9`

### 4.5 Button

- Primary: `bg-primary text-primary-foreground`
- Secondary: `bg-muted text-foreground`
- Outline: `border border-border text-foreground hover:bg-muted`
- Destructive: `text-error hover:bg-error-bg`
- Icon-only sizes: `size-7 rounded-md` (28px square), `size-8 rounded-full` (32 round)

### 4.6 Chip / badge

```
rounded bg-fill-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary
```

### 4.7 Content scroll

The page body owns its scroll:
```
min-h-0 flex-1 overflow-y-auto scrollbar-none
```
Custom scrollbar is hidden. The inner content column has
`pb-16` bottom padding so the last row never hugs the modal edge.

---

## 5. Tokens used inside Settings

| Token                            | Value                                                          |
|----------------------------------|----------------------------------------------------------------|
| `--agents-content-area-bg`       | `var(--color-bg-container)`                                    |
| `--agents-content-area-gap`      | `4px`                                                          |
| `--agents-content-area-radius`   | `12px`                                                         |
| `--agents-layout-bg`             | `var(--surface-canvas)` (flat neutral shell — **DO NOT** paint a 172deg gradient here, see warning below) |
| `--settings-nav-row-selected-bg` | `var(--color-fill-secondary)`                                  |

> ⚠️ **DO NOT paint a 172deg gradient on the layout/shell background.**
>
> The RE notes here historically said `--agents-layout-bg` is
> `linear-gradient(172deg, var(--color-fill-tertiary) 19.61%, var(--color-bg-container) 81.35%)`. That value was an **artifact of the bundle CSS we copied**, not what the live reference product actually paints.
> WAWQAQ has called this out four times in a row (msgs `1e693dee` /
> `5d3b10e5` / `486b5611` / `4a1b8c13`) — "谁让你他妈的用渐变的啊？
> 参考实现就没有啊". Every time we re-added the gradient because
> some atlas/RE note claimed it was canon.
>
> Source-side enforcement: `apps/desktop/src/main/__tests__/chat-chrome-no-gradient-contract.test.ts` fails if any of `.appFrame`, `html[data-os="darwin"] .maka-session-panel`, or the floating panel reintroduces a gradient / border-right / smaller-than-12px radius. If a future RE iteration finds a *new* place where the reference product genuinely does paint a gradient, please update the contract test with the new exception in the same PR, don't silently lift the assertion.
>
> Use a **flat neutral shell** (`var(--surface-canvas)`) behind the
> white content surface. Do not collapse the shell to the same white
> as the content card: that removes the visible lower radius and lets
> the bug come back even without a border or gradient.
>
> Rendered-pixel enforcement: after capturing
> `sidebar-long-sessions/light-1280-motion`, run
> `npm --workspace @maka/desktop run screenshots:chat-chrome:check`.
> It verifies the actual PNG has a visible shell/content delta, no dark
> one-pixel seam, and readable bottom surface corners.
>
> Surface radius is **12px** (was historically noted as 6px). 6px was
> geometrically there but optically invisible — bottom corners of the
> floating content card didn't read against a same-color shell.

Color tokens consumed inside settings:
- `--color-text` (primary text)
- `--color-text-secondary`
- `--color-text-tertiary` (hints)
- `--color-text-quaternary` (de-emphasized)
- `--color-border` (strong divider)
- `--color-border-tertiary` (input borders)
- `--color-fill-secondary` (active row fill)
- `--color-fill-tertiary` (chip background)
- `--color-bg-container` (page surface)
- `--color-primary`, `--color-primary/20`, `--color-primary/40` (focus, switch on, ring)

---

## 6. Routing, state, behaviors

- Active tab is stored in the URL: `?view=settings&tab=preferences`.
  No localStorage for the active tab — round-tripping the URL restores
  the page.
- Deeplink scheme: external triggers can deep-link to a specific tab:
  `qoder-work://settings/preferences`. Maka's equivalent could be
  `maka://settings/<tab>`.
- Default tab when opened with no `tab` param: `preferences`.
- Modal close is escape-key + click-outside backdrop; focus is trapped
  inside `[role="dialog"]`.
- Telemetry: `settings_tab_view` fires when a tab is selected;
  `settings_heartbeat` ticks every 300s with a feature-flag snapshot.
- Saves: per-control, no explicit batch / "save" button visible.
  Renderer dispatches IPC writes per change; toasts surface failures.

---

## 7. Implications for Maka

This RE matters because WAWQAQ's ask — "add a 系统设置 section" — is
ALMOST CORRECT but the deeper truth from the reference is:

**Reference does NOT scatter system-level toggles into their own
narrow pages.** It collapses them into ONE long `Preferences` page,
and reserves a near-empty `system` tab for future expansion.

Maka today has 17 nav items in Settings (some of them — `网络`,
`健康`, `开放网关`, `语音模型`, `每日回顾`, `记忆` — are single-purpose
pages that mirror exactly the "wasteful single-purpose page" pattern
WAWQAQ flagged for `网络`).

The closer-to-reference move is to **consolidate**, not add another
section. Concrete proposal:

### Proposed consolidated Maka Settings nav (target: ~9 items)

| Group       | Item        | Holds                                                      |
|-------------|-------------|------------------------------------------------------------|
| 基础         | 通用         | Aggregator: 隐身模式, 启动行为, 新对话模式, 默认模型, 通知, 网络代理, 保持唤醒, 自动更新, 关闭窗口行为 |
| 基础         | 外观         | 个性化 + theme + palette + font (merge 主题 + 个性化)          |
| AI          | 模型         | Provider connections + OAuth + per-model config            |
| AI          | 记忆与回顾    | Merge `记忆` + `每日回顾`                                     |
| AI          | 语音与网关    | Merge `语音模型` + `开放网关`                                  |
| 集成         | 机器人对话    | Telegram / WeChat / Slack bot config                       |
| 集成         | 联网搜索      | Tavily provider config                                     |
| 数据/系统    | 数据         | Export / import / wipe                                     |
| 数据/系统    | 权限与能力    | Capability toggles + filesystem allowlist                  |
| 其他         | 健康         | Diagnostic / status / logs                                 |
| 其他         | 关于         | Version + license + acknowledgements                       |

Specifically: **drop the standalone `网络` page; move proxy into 通用**.
That's the minimum WAWQAQ asked for, but ride the same PR to merge
`主题 + 个性化` into `外观` per reference, since 外观 is reference's
canonical name for that grouping.

### Settings page-body recipe to copy

For ANY settings page body, switch to:
- `max-w-3xl mx-auto pt-10 pb-16` inner column
- Flat row list (`flex items-center gap-3 px-4 py-3` per row)
- `text-sm font-medium` title + `text-xs text-text-quaternary` hint
- No bordered card around row groups
- Sub-section heading: `text-sm font-semibold mb-4`
- Switches / inputs / chips per §4 above

This is the visual "reference 真好看" pattern WAWQAQ asked us to study —
the page is uncluttered because rows have NO chrome, only spacing.

---

## 8. PR plan suggestion

Two PRs, ship in sequence:

**PR-SETTINGS-ALIGN-IA-0** — Information architecture consolidation
- Drop standalone `网络` page; fold proxy into a "网络代理" sub-section of 通用
- Merge `主题 + 个性化` → `外观`
- Merge `记忆 + 每日回顾` → `记忆与回顾`
- Merge `语音模型 + 开放网关` → `语音与网关`
- Update SETTINGS_NAV + section render switch + all deeplinks (`maka://settings/...`)
- Pin via contract test: nav id allowlist + deeplink mapping

**PR-SETTINGS-PAGE-BODY-0** — Visual pattern conversion
- Convert every page body from `settingsStructuredPage / SettingRow`
  card chrome to the flat-row + `max-w-3xl` recipe
- Add `.maka-settings-row`, `.maka-settings-page` primitives in styles.css
- Sweep all SettingsPage components to use them

Tackle them in this order so the IA stops shifting while we're polishing
the bodies.
