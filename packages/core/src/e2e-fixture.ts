import type { ToolActivityStatus } from './tool-result-status.js';
import type { BotOnboardingProvider } from './bot-onboarding.js';
import type { SandboxBoundaryRequestEvent, ToolOutputStream, ToolResultContent } from './events.js';
import type { SettingsSection } from './settings.js';
import type { UiLocale } from './ui-locale.js';

export type E2eFixtureScenario =
  | 'all'
  | 'first-run'
  | 'provider-workspace'
  | 'fallback-source'
  | 'fetched-empty'
  | 'connection-error'
  // OAuth re-login: seeds a openai-codex (OAuth) connection that last
  // tested needs_reauth and focuses its detail sheet, so the inline 登录 /
  // 重新登录 affordance the detail sheet gained is visible where an expired
  // OAuth login must be re-run — the surface that used to be dead prose.
  | 'oauth-relogin'
  | 'turn-narrative'
  | 'task-ledger'
  | 'deep-research-progress'
  | 'artifact-pane'
  | 'artifact-errors'
  | 'streaming-sidebar'
  | 'disclosure-output'
  // PR-STREAM-TURN-CENTER: streaming-sidebar only shows the SIDEBAR dot (its
  // active session is a committed one). This seeds an ACTIVE session whose
  // main panel renders the live answer bubble below a committed turn, so
  // streaming-vs-committed horizontal alignment is locked
  // deterministically — the gap
  // that let the "streaming markdown sits ~110px too far left" bug ship.
  | 'streaming-answer'
  // #646 real-time status language: a running session whose turn is armed with
  // nothing streaming yet — the "正在处理…" model-wait indicator rides the tail
  // turn and the composer shows Stop. Locks the connect-to-first-token state.
  | 'model-processing'
  | 'sandbox-boundary'
  | 'stale-sessions'
  | 'settings-data'
  // PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: memory and
  // daily-review split back apart; appearance stays merged; network
  // folded into general.
  | 'settings-appearance'
  | 'settings-bots'
  // #1233 deferral: the bot QR-onboarding modal (bot-onboarding-modal.tsx)
  // had no deterministic capture because a real device-code start contacts an
  // external IM platform and the QR + TTL drift every run. This scenario opens
  // Settings → 远程接入 → a bot detail with the scan-login modal auto-opened,
  // backed by an e2e-fixture adapter that holds the 'waiting' state with a
  // FIXED QR + long TTL, so the modal's waiting layout renders deterministically.
  | 'settings-bots-onboarding'
  | 'settings-about'
  | 'settings-general'
  | 'settings-memory'
  | 'settings-daily-review'
  | 'settings-permissions'
  | 'settings-voice'
  | 'settings-usage'
  | 'settings-health'
  | 'module-skills'
  | 'composer-skill-invocation'
  | 'module-mcp'
  | 'module-daily-review'
  | 'workstation-statuses'
  | 'plan-reminders'
  // PR109f (g): turn-control-history — seeds a primary session whose
  // turn list covers retried / regenerated / aborted / failed and two
  // branch sessions (one with visible parent showing the banner, one
  // with a missing parent that must NOT render a banner). The three
  // scenarios below share the same on-disk seed; they only differ in
  // which session is the active one, exposing three deterministic
  // states covering both positive and negative banner cases without
  // requiring manual clicks.
  | 'turn-control-history'
  | 'turn-control-branch-visible'
  | 'turn-control-branch-orphan'
  // PR-UI-RENDER-3a-smoke: three artifact preview fixtures lock the
  // visual contract for the new registry-driven image path. Each
  // scenario writes a SINGLE artifact to ARTIFACT_SESSION_ID so the
  // ArtifactPane's default selection (records[0]) deterministically
  // shows the one we want to verify. @kenji review @msg
  // fc9753b9 holds review sign-off pending these three.
  //   - artifact-preview-image: real tiny PNG → registry resolves
  //     `image(mime_match)`, <img object-fit:contain> inside bounded
  //     container.
  //   - artifact-preview-unsupported: kind=image + mimeType=image/
  //     heic (disallowed by allowlist). Registry resolves L1
  //     `unsupported(mime_disallowed)`. Visual contract: no `<img>`,
  //     UnsupportedCard shows name + mime + size, NO relativePath
  //     leak.
  //   - artifact-preview-oversize: kind=image + mimeType=image/png
  //     + sizeBytes claim > 2MB (via skipFile + sizeBytesOverride).
  //     Registry resolves L1 `unsupported(oversize)` BEFORE
  //     readBinary. Finder button visible (ArtifactPane provides
  //     onShowInFolder).
  | 'artifact-preview-image'
  | 'artifact-preview-unsupported'
  | 'artifact-preview-oversize'
  // PR-SIDEBAR-IA-0 Phase 1 (xuan msg `dc790a54` + kenji `0f7bb872`):
  // sidebar-long-sessions seeds 60 active sessions so the sidebar
  // scroll container can be verified end-to-end: the list must scroll
  // independently, and the footer (Settings + Version info)
  // must stay visible at the bottom regardless of session count.
  // Variant pairs (light + dark, narrow + wide) double
  // as the CI gate that scroll did not regress.
  | 'sidebar-long-sessions'
  // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2 +
  // WAWQAQ msg `4259bf8c`): seed the same 60-session sidebar as
  // sidebar-long-sessions, then auto-open the Search modal at
  // mount so the modal shell is on screen
  // without requiring an interaction. The opener uses
  // `E2eFixtureState.searchModalOpen=true`; real users never
  // receive an e2e-fixture state.
  | 'sidebar-search-modal-open'
  // PR-shared primitive-COMMAND-INPUT-0: reuse the long sidebar seed and
  // auto-open the command palette so the
  // Astryx CommandPalette is exercised without requiring a key chord.
  | 'command-palette-open'
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
  // kenji `b3d156e9`): seed the same 60-session sidebar and
  // programmatically focus the active row's button after mount
  // so the absolute-positioned `.maka-list-row-actions` overlay
  // becomes visible (via `:focus-within`). Verifies that the
  // time meta + unread dot do NOT leak through the action icons
  // — the bug WAWQAQ flagged.
  | 'sidebar-row-actions-visible'
  // Scroll-geometry contract: a 24-turn session whose turns are each ~1300px
  // tall, opened as the active session on boot. Off-screen turns mount as
  // 250px content-visibility placeholders, so this seed exercises the
  // warm-up + pinned-bottom geometry invariants (E2E scroll-geometry spec)
  // and gives the scroll-geometry Playwright spec a long-transcript surface.
  | 'long-transcript'
  // #819: BrowserPanel renderer-chrome fixture. Seeds `liveBrowserSessionIds`
  // with the active turn session so `BrowserPanel` mounts (app-shell gates
  // on `activeId && liveBrowserSessionIds.includes(activeId)`). In
  // e2e-fixture mode there is no native `WebContentsView`, so
  // `browser.getState` resolves null and `BrowserPanel` renders `EMPTY_STATE`
  // — the empty-state chrome (toolbar with all nav buttons disabled + the
  // `<Empty>` strip) that the #818 narrow-layout defect regressed against.
  // Loaded / loading / nav chrome states are locked by the
  // `browser-panel-chrome` source contract (their wiring IS the behavior);
  // they add no layout value over this empty-state fixture.
  | 'browser-empty';

export interface E2eFixtureLiveTool {
  toolUseId: string;
  toolName: string;
  stepId?: string;
  displayName?: string;
  intent?: string;
  status: ToolActivityStatus;
  args: unknown;
  result?: ToolResultContent;
  durationMs?: number;
  outputChunks?: Array<{
    seq: number;
    stream: ToolOutputStream;
    text: string;
    redacted: boolean;
    createdAt: number;
  }>;
  outputTruncated?: boolean;
}

export interface E2eFixtureLiveTurnStep {
  stepId: string;
  thinking?: { text: string; truncated: boolean; complete: boolean };
  text?: { text: string; truncated: boolean; complete: boolean };
  tools: E2eFixtureLiveTool[];
}

export interface E2eFixtureLiveTurnProjection {
  turnId: string;
  phase: 'waiting' | 'streamed';
  terminal?: true;
  steps: E2eFixtureLiveTurnStep[];
}

export interface E2eFixtureState {
  enabled: true;
  /**
   * Deterministic wall-clock timestamp for fixture rendering. The
   * renderer uses it to freeze `Date.now()` while e2e-fixture mode is
   * active so relative-time labels, fetched-at copy, and transient
   * permission timestamps do not drift between runs.
   */
  now?: number;
  activeSessionId?: string;
  /**
   * #819: session ids with a live embedded-browser view, mirrorring the
   * renderer's `liveBrowserSessionIds` state (app-shell gates `BrowserPanel`
   * mounting on `activeId && liveBrowserSessionIds.includes(activeId)`).
   * Seeded only by the `browser-empty` scenario so the renderer chrome is
   * reachable for inspection. Real users never receive an e2e-fixture state, so
   * this never drives production `browser:live` wiring.
   */
  liveBrowserSessionIds?: string[];
  openSettingsSection?: SettingsSection;
  /**
   * Fixture-only composer draft. The renderer focuses the real textarea and
   * dispatches its normal input path so mention popups are captured without a
   * test-only component branch.
   */
  composerText?: string;
  /**
   * When set, open Settings → 模型 with this connection's detail sheet
   * expanded (rather than just the section). Seeded by `oauth-relogin` so the
   * detail sheet's re-login affordance is what gets exposed; takes
   * precedence over `openSettingsSection`.
   */
  openConnectionDetailSlug?: string;
  liveTurnBySession?: Record<string, E2eFixtureLiveTurnProjection>;
  sandboxBoundaryBySession?: Record<string, SandboxBoundaryRequestEvent>;
  /**
   * PR-IR-04: force `prefers-reduced-motion: reduce` behavior regardless
   * of the host OS setting. Triggered by `MAKA_E2E_FIXTURE_REDUCED_MOTION=1`
   * env var in the main process. The renderer applies
   * `data-maka-reduced-motion="true"` to `<html>` so the matching CSS
   * rule in `styles.css` collapses every animation/transition to
   * ~0.01ms.
   */
  reducedMotion?: boolean;
  /**
   * PR-IR-01b: theme override driven by `MAKA_E2E_FIXTURE_THEME=light|dark|auto`.
   * Lets each scenario be exercised in both light
   * and dark themes without requiring per-fixture seed updates. The
   * renderer applies this BEFORE the user's persisted theme so the
   * first paint already has the right palette.
   */
  theme?: 'light' | 'dark' | 'auto';
  /**
   * PR-UI-VISUAL-SMOKE-LOCALE: UI locale override driven by
   * `MAKA_E2E_FIXTURE_LOCALE=zh|en`. The reactive locale provider
   * normally follows the persisted preference. When set, the renderer
   * records `data-maka-e2e-fixture-locale="zh|en"` on `<html>` and
   * resolves that override before the persisted preference.
   * Unrecognized values fall back to undefined.
   */
  locale?: UiLocale;
  /**
   * PR-UI-VISUAL-SMOKE-TIMEZONE: IANA timezone override driven by
   * `MAKA_E2E_FIXTURE_TIMEZONE=<IANA name>`. Mirrors the locale
   * override pattern: when set, the renderer applies
   * `data-maka-e2e-fixture-tz="<IANA>"` to `<html>` so any date /
   * time formatting helper can read it BEFORE falling back to the
   * host system timezone.
   *
   * Validation is via `Intl.DateTimeFormat(undefined, { timeZone })`
   * (throws RangeError on invalid IANA names). Invalid timezone
   * values fall back to undefined (renderer uses host system
   * timezone as today). Same scope as locale: contract + attribute
   * write only; per-call timezone consumption is up to individual
   * formatters as they're added.
   *
   * Real users never receive an e2e-fixture state, so their Date
   * formatting remains untouched.
   */
  timezone?: string;
  /**
   * PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2): when
   * `true`, the renderer auto-opens the sidebar Search modal at
   * mount so the modal shell is on screen
   * deterministically (the modal is not the default state of any
   * scenario; opening it requires either user input or this hint).
   *
   * Currently set only by the `sidebar-search-modal-open` scenario.
   * Real users never receive an e2e-fixture state, so this never
   * affects the production app.
   */
  searchModalOpen?: boolean;
  /**
   * PR-shared primitive-COMMAND-INPUT-0: when `true`, the renderer auto-opens
   * the command palette at mount so the
   * command input shell is on screen deterministically. Currently set
   * only by `command-palette-open`.
   */
  paletteOpen?: boolean;
  /**
   * PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
   * kenji `b3d156e9`): when `true`, the renderer focuses the
   * active row's `.maka-list-row-main` button after mount so the
   * row's `:focus-within` triggers and the absolute-positioned
   * `.maka-list-row-actions` overlay becomes visible. The fixture
   * then shows the actions cluster — without this hint, default
   * fixture renders never have any focused row, so the overlap fix
   * (`.maka-list-row:focus-within .maka-list-row-meta {
   * visibility: hidden }`) can't be verified without a focused row.
   *
   * Currently set only by the `sidebar-row-actions-visible`
   * scenario.
   */
  focusActiveRow?: boolean;
  /**
   * Fixture-only sidebar module override. Used by scenarios that need
   * to render non-session sidebar content without adding a real
   * router path.
   */
  sidebarSection?: 'sessions' | 'automations' | 'skills' | 'mcp' | 'daily-review';
  /**
   * Fixture-only sidebar collapsed override. Fixture runs use a
   * fresh userData dir, while the real app defaults to the collapsed
   * target-layout like rail when no local preference exists. Sidebar
   * visual gates must opt into the expanded panel explicitly so the
   * rendered fixture proves the rows, counts, groups, and footer instead of
   * only the top-left icon rail.
   */
  sidebarCollapsed?: boolean;
  /** Fixture-only session workbar state for deterministic tab rendering. */
  workbarCollapsed?: boolean;
  workbarTab?: 'tasks' | 'browser' | 'files';
  /**
   * #1233 deferral — bot QR-onboarding modal fixture. When set, the Settings
   * 远程接入 page (bot-chat-settings-page) opens the given provider's detail
   * view and auto-opens its scan-login modal at mount, so the deterministic
   * waiting-state QR fixture is what the alignment audit sees. Only the
   * `settings-bots-onboarding` scenario sets this; real users never receive an
   * e2e-fixture state so production onboarding is untouched.
   */
  botOnboardingProvider?: BotOnboardingProvider;
}
