import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { UiLocale, E2eFixtureScenario, E2eFixtureState } from '@maka/core';
import {
  backfillSessionProjects,
  createProjectCatalog,
  createSessionStore,
} from '@maka/storage';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import type { CredentialStore } from './credential-store.js';
import {
  ARTIFACT_SESSION_ID,
  ERROR_SESSION_ID,
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_NAME,
  LONG_SIDEBAR_SCENARIOS,
  LONG_SIDEBAR_SESSION_PREFIX,
  LONG_TRANSCRIPT_SESSION_ID,
  OVERFLOWING_RAIL_SESSION_ID,
  PERMISSION_SESSION_ID,
  PROCESSING_SESSION_ID,
  SHORT_FINAL_TURN_SESSION_ID,
  STALE_FAKE_SESSION_ID,
  STREAMING_SESSION_ID,
  TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID,
  TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID,
  TURN_CONTROL_PRIMARY_SESSION_ID,
  TURN_CONTROL_SCENARIOS,
  TURN_SESSION_ID,
  E2E_FIXTURE_NOW,
  WORKSTATION_RUNNING_SESSION_ID,
  writeJson,
  writeSession,
} from './e2e-fixture/seed-helpers.js';
import {
  artifactMessages,
  artifactSession,
  writeArtifacts,
} from './e2e-fixture/scenarios-artifacts.js';
import {
  errorMessages,
  errorSession,
  sandboxBoundaryLiveTurns,
  permissionMessages,
  permissionSession,
  sandboxBoundaryState,
  processingLiveTurns,
  processingMessages,
  processingSession,
  streamingAnswerLiveTurns,
  streamingLiveTurns,
  streamingMessages,
  streamingSession,
  turnMessages,
  turnSession,
  writeTaskLedgerFixture,
} from './e2e-fixture/scenarios-chat.js';
import {
  seedMcpFixture,
  seedSkillsMarketFixture,
} from './e2e-fixture/scenarios-modules.js';
import {
  healthyMessages,
  healthySession,
  longSidebarSessions,
  longTranscriptMessages,
  longTranscriptSession,
  overflowingRailMessages,
  overflowingRailSession,
  shortFinalTurnMessages,
  shortFinalTurnSession,
  staleFakeMessages,
  staleFakeSession,
  turnControlSessions,
  workstationStatusSessions,
} from './e2e-fixture/scenarios-sessions.js';
import {
  writeConnections,
  writeDailyReviewArchives,
  writePlanReminders,
  writeSettings,
} from './e2e-fixture/scenarios-settings.js';
import { usageStatsSessions } from './e2e-fixture/scenarios-usage.js';
import {
  DEEP_RESEARCH_SESSION_ID,
  deepResearchMessages,
  deepResearchSession,
  writeDeepResearchLedger,
} from './e2e-fixture/scenarios-deep-research.js';

const E2E_FIXTURE_SCENARIOS = new Set<E2eFixtureScenario>([
  'all',
  'first-run',
  'provider-workspace',
  'fallback-source',
  'fetched-empty',
  'connection-error',
  // OAuth re-login affordance: a openai-codex connection with a stored
  // but expired OAuth token (hasSecret===true), focused so its detail sheet's
  // 重新登录 button is visible.
  'oauth-relogin',
  'turn-narrative',
  'task-ledger',
  'deep-research-progress',
  'artifact-pane',
  'artifact-errors',
  'streaming-sidebar',
  'disclosure-output',
  // PR-STREAM-TURN-CENTER: active session renders the live answer bubble in
  // the main panel (below a committed turn) so
  // streaming-vs-committed horizontal alignment is locked deterministically.
  'streaming-answer',
  // #646: a running session with an armed turn but nothing streaming yet —
  // captures the "正在处理…" model-wait indicator + composer Stop.
  'model-processing',
  'sandbox-boundary',
  'stale-sessions',
  // PR108j: per-Settings-section fixtures so each Settings sub-page can
  // be opened deterministically over the standard seed. Each scenario
  // reuses the standard
  // connection / session seed and only differs in
  // `openSettingsSection`. (Per-page state — displayName,
  // assistantTone, network proxy, etc. — already comes from the
  // default settings.json seed.)
  'settings-data',
  // PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: memory and
  // daily-review split back apart per WAWQAQ msg `886f6406`.
  'settings-appearance',
  'settings-bots',
  // #1233 deferral: deterministic bot QR-onboarding modal fixture. Shares the
  // settings-bots seed but auto-opens a provider detail's scan-login modal,
  // backed by a hold-in-waiting e2e-fixture onboarding adapter (fixed QR +
  // long TTL). See `createE2eFixtureBotOnboardingAdapters`.
  'settings-bots-onboarding',
  'settings-about',
  'settings-general',
  'settings-memory',
  'settings-daily-review',
  'settings-permissions',
  'settings-voice',
  'settings-usage',
  'settings-health',
  'module-skills',
  'composer-skill-invocation',
  // MCP module page: opens the 扩展 → MCP surface with a seeded mcp.json so
  // the marketplace, command bar, and configured server list all render
  // through the same production path for the alignment auditor (light).
  'module-mcp',
  'module-daily-review',
  // PR109b: workstation-statuses — seed one session per SessionStatus
  // (running / waiting_for_user / blocked × 4 reasons / active / review
  // / done / archived) so the sidebar grouping covers every
  // status badge + group header in one fixture.
  'workstation-statuses',
  // PR-PLAN-REMINDER-MVP-0: exercise the first real Automations
  // surface. Seeds scheduled / paused / completed local reminders and
  // opens the 计划 module so reviewers can verify this is real product
  // UI rather than a passive placeholder.
  'plan-reminders',
  // PR109f (g): turn-control-history — seeds a primary session whose
  // turn list covers the four TurnStatus values plus retry + regenerate
  // lineage, alongside two branch sessions (visible-parent vs missing-
  // parent) so the banner contract is covered end-to-end.
  // Three variants share the same on-disk seed and only differ in
  // active session selection, exposing three deterministic states:
  //   - turn-control-history          → primary active (lineage / aborted / failed)
  //   - turn-control-branch-visible   → visible-parent branch active (banner)
  //   - turn-control-branch-orphan    → orphan branch active (NO banner)
  'turn-control-history',
  'turn-control-branch-visible',
  'turn-control-branch-orphan',
  // PR-UI-RENDER-3a-smoke: registry-driven artifact preview fixtures.
  // Each shares the standard chat seed + same ARTIFACT_SESSION_ID but
  // writes a different single artifact so the ArtifactPane default
  // selection deterministically shows the artifact we want.
  'artifact-preview-image',
  'artifact-preview-unsupported',
  'artifact-preview-oversize',
  // PR-SIDEBAR-IA-0 Phase 1: seed 60 active sessions so the sidebar
  // scroll fix is verifiable end-to-end. Footer (Settings + Update
  // placeholder) must stay visible in narrow / wide / light / dark
  // variants. See `seedLongSidebarSessions()`.
  'sidebar-long-sessions',
  // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2):
  // shares the sidebar-long-sessions on-disk seed (60 sessions) so
  // the sidebar behind the modal looks identical to the
  // sidebar-long-sessions fixture; differs only in
  // `searchModalOpen: true`, which auto-opens the sidebar Search
  // modal at mount. Renders the SearchModal shell deterministically
  // so xuan's Phase 2 modal gate has a stable fixture state.
  'sidebar-search-modal-open',
  // PR-shared primitive-COMMAND-INPUT-0: same 60-session seed; differs only in
  // `paletteOpen: true`, which auto-opens CommandPalette so command-input
  // shell changes have a stable fixture state.
  'command-palette-open',
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
  // kenji `b3d156e9`): same 60-session seed; differs in
  // `focusActiveRow: true`, which programmatically focuses the
  // active row's button after mount so `:focus-within` triggers
  // and the official session item receives focus.
  // Captures the overflow-trigger state so reviewers can verify
  // the time meta + unread dot are hidden underneath (no overlap).
  'sidebar-row-actions-visible',
  // Scroll-geometry contract seed: 24 tall turns opened as the active
  // session on boot, so off-screen turns mount as content-visibility
  // placeholders (see e2e/scroll-geometry.spec.ts).
  'long-transcript',
  // Prompt-rail activation contract: a transcript whose final turn is one
  // line, which never crosses the rail's top-third activation band
  // (see e2e/prompt-rail.spec.ts).
  'short-final-turn',
  // Prompt-rail overflow contract: enough prompts that the rail exceeds its cap
  // and scrolls independently (see e2e/prompt-rail.spec.ts).
  'overflowing-rail',
  // #819: BrowserPanel renderer-chrome fixture. Seeds `liveBrowserSessionIds`
  // with the active turn session so `BrowserPanel` mounts; with no native
  // `WebContentsView` in e2e-fixture mode, `browser.getState` resolves null
  // → `EMPTY_STATE` → the empty-state chrome (toolbar all-nav-disabled +
  // `<Empty>` strip) the #818 narrow-layout defect regressed against.
  'browser-empty',
]);

export interface E2eFixture {
  scenario: E2eFixtureScenario;
  workspaceName: string;
  /**
   * PR-IR-04: when `MAKA_E2E_FIXTURE_REDUCED_MOTION=1` is set alongside
   * the scenario var, the renderer collapses all animations to ~0.01ms
   * via the `[data-maka-reduced-motion="true"]` CSS path. Lets every
   * surface be exercised in a "reduced motion" variant without depending
   * on the host OS accessibility setting.
   */
  reducedMotion: boolean;
  /**
   * PR-IR-01b: theme override (light | dark | auto). null means "use
   * the user's persisted theme preference". Unknown values fail closed
   * to null.
   */
  theme: 'light' | 'dark' | 'auto' | null;
  /**
   * PR-UI-VISUAL-SMOKE-LOCALE: UI locale override (zh | en). null
   * means "use the persisted locale preference". When set,
   * the renderer passes the value to LocaleProvider, which synchronizes
   * document metadata and consumers to the locked value
   * deterministically — same fixture, same locale, same rendered state
   * across hosts. Driven by env var
   * `MAKA_E2E_FIXTURE_LOCALE=zh|en`. Unknown values fail closed.
   */
  locale: UiLocale | null;
  /**
   * PR-UI-VISUAL-SMOKE-TIMEZONE: IANA timezone override. null means
   * "use the host system timezone" (current behavior). When set, the
   * renderer applies `data-maka-e2e-fixture-tz=<IANA>` to `<html>`
   * so any date/time formatting helper that opts in can read the
   * locked value deterministically — same fixture, same timezone,
   * same rendered state across hosts. Driven by env var
   * `MAKA_E2E_FIXTURE_TIMEZONE=<IANA name>`. Validation via
   * `Intl.DateTimeFormat(undefined, { timeZone })`; invalid values
   * fail closed to null.
   */
  timezone: string | null;
  /**
   * #1312: platform override (darwin | win32 | linux). null means "report
   * the real `process.platform`". When set, `app:info` reports this value,
   * so the renderer's app-shell-effects sets `data-os` to the forced
   * platform through the production path and the window boots natively
   * into that platform's CSS cascade (e.g. the darwin glass overrides) —
   * no post-boot attribute flip. Driven by env var
   * `MAKA_E2E_FIXTURE_PLATFORM=darwin|win32|linux`. Unknown values fail
   * closed to null.
   */
  platform: 'darwin' | 'win32' | 'linux' | null;
}

export function resolveE2eFixture(
  rawScenario: string | undefined,
  isPackaged: boolean,
  rawReducedMotion: string | undefined = undefined,
  rawTheme: string | undefined = undefined,
  rawLocale: string | undefined = undefined,
  rawTimezone: string | undefined = undefined,
  rawPlatform: string | undefined = undefined,
): E2eFixture | null {
  if (!rawScenario) return null;
  if (isPackaged) {
    throw new Error('MAKA_E2E_FIXTURE is only available in dev/test builds.');
  }
  if (!E2E_FIXTURE_SCENARIOS.has(rawScenario as E2eFixtureScenario)) {
    throw new Error(`Unknown MAKA_E2E_FIXTURE scenario: ${rawScenario}`);
  }
  const scenario = rawScenario as E2eFixtureScenario;
  const reducedMotion = parseReducedMotionFlag(rawReducedMotion);
  const theme = parseThemeFlag(rawTheme);
  const locale = parseLocaleFlag(rawLocale);
  const timezone = parseTimezoneFlag(rawTimezone);
  const platform = parsePlatformFlag(rawPlatform);
  return {
    scenario,
    workspaceName: `e2e-fixture-${scenario}`,
    reducedMotion,
    theme,
    locale,
    timezone,
    platform,
  };
}

/**
 * Validate the theme override. Accepts only the closed enum
 * `light | dark | auto`; everything else fails closed to null
 * (renderer falls back to the user's persisted preference).
 */
function parseThemeFlag(raw: string | undefined): 'light' | 'dark' | 'auto' | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'light' || normalized === 'dark' || normalized === 'auto') return normalized;
  return null;
}

/**
 * Validate the UI locale override. Accepts only the closed enum
 * `zh | en`; everything else fails closed to null (renderer falls
 * back to the persisted preference). PR-UI-VISUAL-SMOKE-LOCALE.
 */
function parseLocaleFlag(raw: string | undefined): UiLocale | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'en') return normalized;
  return null;
}

/**
 * Validate the IANA timezone override.
 * PR-UI-VISUAL-SMOKE-TIMEZONE (@kenji msg 45486cdf).
 *
 * Unlike locale, timezone has no finite enum — there are hundreds
 * of IANA timezone names plus aliases. The validation gate is the
 * Intl.DateTimeFormat constructor: passing an unknown `timeZone`
 * throws RangeError, so we try / catch and fall back to null on
 * any failure. This catches:
 *   - undefined / empty string
 *   - malformed strings (`Asia/Imaginary`, `Foo`)
 *   - case-mismatch IANA aliases (some platforms accept
 *     `america/new_york` lowercase, some don't — we keep the
 *     raw input; if `Intl.DateTimeFormat` accepts it, that's the
 *     answer for THIS runtime)
 *   - any future input shape we don't anticipate
 *
 * Length cap (128 chars) defends against pathological inputs;
 * real IANA names are < 40 chars.
 *
 * Trim-only normalization (no toLowerCase): IANA names are
 * mixed-case (`America/New_York`, `Asia/Shanghai`); lowering
 * them breaks the lookup on strict platforms.
 */
function parseTimezoneFlag(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  try {
    // Construct a formatter purely to validate the timeZone option;
    // throws RangeError on invalid IANA names.
    new Intl.DateTimeFormat(undefined, { timeZone: trimmed });
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * Validate the platform override (#1312). Accepts only the closed enum
 * `darwin | win32 | linux` — the three platforms the renderer's `data-os`
 * cascade branches on; everything else fails closed to null (app:info
 * reports the real `process.platform`).
 */
function parsePlatformFlag(raw: string | undefined): 'darwin' | 'win32' | 'linux' | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'darwin' || normalized === 'win32' || normalized === 'linux') return normalized;
  return null;
}

function parseReducedMotionFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Sandbox-boundary requests the user has already answered.
 *
 * The fixture's requests are rebuilt from the scenario on every read, so
 * answering one cannot retire it the way a real one is retired — the runtime
 * drops an active request from its in-memory owner state when the decision is
 * acknowledged, and the fixture's request has no such owner. Without somewhere
 * to remember the answer the request keeps coming back, and a decision that
 * leaves the request pending is not a decision.
 *
 * It lives here rather than at either exit because there are two: the sessions
 * IPC serves the active-request list, and `e2eFixture:getState` hands the
 * renderer a state it seeds its interaction queue from directly. A retirement
 * either exit could not see would only move the resurrection to the other one.
 *
 * Deliberately not persisted: the answer belongs to the run, and every run
 * starts from a throwaway userData dir with the request unanswered again.
 */
const answeredSandboxBoundaryRequests = new Set<string>();

/** Retire an answered fixture request from every reader of fixture state. */
export function retireE2eFixtureSandboxBoundaryRequest(requestId: string): void {
  answeredSandboxBoundaryRequests.add(requestId);
}

/** Test seam: the retirement set is module state shared across cases. */
export function resetE2eFixtureSandboxBoundaryRetirement(): void {
  answeredSandboxBoundaryRequests.clear();
}

export function getE2eFixtureState(fixture: E2eFixture | null): E2eFixtureState | null {
  const state = buildE2eFixtureState(fixture);
  if (!state?.sandboxBoundaryBySession) return state;
  return {
    ...state,
    sandboxBoundaryBySession: Object.fromEntries(
      Object.entries(state.sandboxBoundaryBySession).filter(
        ([, request]) => !answeredSandboxBoundaryRequests.has(request.requestId),
      ),
    ),
  };
}

function buildE2eFixtureState(fixture: E2eFixture | null): E2eFixtureState | null {
  if (!fixture) return null;
  const state: E2eFixtureState = {
    enabled: true,
    now: E2E_FIXTURE_NOW,
    ...(fixture.reducedMotion ? { reducedMotion: true } : {}),
    ...(fixture.theme ? { theme: fixture.theme } : {}),
    ...(fixture.locale ? { locale: fixture.locale } : {}),
    ...(fixture.timezone ? { timezone: fixture.timezone } : {}),
  };
  switch (fixture.scenario) {
    case 'first-run':
      return state;
    case 'provider-workspace':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'fallback-source':
    case 'fetched-empty':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'oauth-relogin':
      // Open the persisted Codex connection's detail sheet (not just the 模型
      // section) so the needs_reauth re-login affordance is captured.
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        openSettingsSection: 'models',
        openConnectionDetailSlug: 'codex-subscription',
      };
    case 'connection-error':
      return { ...state, activeSessionId: ERROR_SESSION_ID, openSettingsSection: 'models' };
    case 'artifact-pane':
    case 'artifact-errors':
    // PR-UI-RENDER-3a-smoke: each preview scenario shares the same
    // chat session as `artifact-pane`; only the on-disk artifact
    // varies. The ArtifactPane selects records[0] by default so the
    // single seeded artifact is what gets rendered.
    case 'artifact-preview-image':
    case 'artifact-preview-unsupported':
    case 'artifact-preview-oversize':
      return { ...state, activeSessionId: ARTIFACT_SESSION_ID, workbarCollapsed: false, workbarTab: 'files' };
    case 'turn-narrative':
    case 'task-ledger':
      return { ...state, activeSessionId: TURN_SESSION_ID, workbarCollapsed: false, workbarTab: 'tasks' };
    case 'deep-research-progress':
      return { ...state, activeSessionId: DEEP_RESEARCH_SESSION_ID };
    case 'browser-empty':
      // #819: the active turn session is also seeded as a live browser
      // session so BrowserPanel mounts over the chat. No native
      // WebContentsView exists in e2e-fixture mode, so browser.getState
      // resolves null → BrowserPanel renders EMPTY_STATE → the empty-state
      // chrome is what the fixture exposes (the #818 defect surface).
      // Loaded / loading / nav chrome states are locked by the
      // `browser-panel-chrome` source contract; they add no layout
      // value over this empty-state fixture.
      return { ...state, activeSessionId: TURN_SESSION_ID, liveBrowserSessionIds: [TURN_SESSION_ID], workbarCollapsed: false, workbarTab: 'browser' };
    case 'streaming-sidebar':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        liveTurnBySession: streamingLiveTurns(),
      };
    case 'disclosure-output':
      return {
        ...state,
        activeSessionId: STREAMING_SESSION_ID,
        liveTurnBySession: streamingLiveTurns(),
      };
    case 'streaming-answer':
      // Active session = the committed turn-narrative session, PLUS a live
      // answer streaming into it. The main panel then shows a settled turn
      // and the in-flight bubble together, so they provably
      // share the same centered column (the streaming-turn-center fix).
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        liveTurnBySession: streamingAnswerLiveTurns(),
      };
    case 'model-processing':
      // #646: a running session whose live projection is armed with
      // NO streaming / thinking / tool seeded, so the derivation fires and the
      // "正在处理…" indicator rides the tail user turn while the composer shows
      // Stop. The session's on-disk status is `running` so the status gate self-
      // heals like the real backgrounded-session path.
      return {
        ...state,
        activeSessionId: PROCESSING_SESSION_ID,
        liveTurnBySession: processingLiveTurns(),
      };
    case 'sandbox-boundary':
      return {
        ...state,
        activeSessionId: PERMISSION_SESSION_ID,
        sandboxBoundaryBySession: sandboxBoundaryState(),
        liveTurnBySession: sandboxBoundaryLiveTurns(),
      };
    case 'stale-sessions':
      // Active session intentionally a stale one — verifies the @kenji
      // gate that an active+stale row still shows the "已过期" pill
      // (active highlight must not erase the warning signal).
      return { ...state, activeSessionId: STALE_FAKE_SESSION_ID };
    // PR108j: Settings sub-page scenarios. Each just opens the relevant
    // Settings section over the standard seed; per-page state lives in
    // the shared settings.json defaults (already includes displayName
    // = '' so the chat surface falls back to '你', etc.). Active session stays TURN_SESSION_ID so the chat
    // surface behind the modal shows a realistic context.
    case 'settings-data':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'data' };
    case 'settings-appearance':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'appearance' };
    case 'settings-bots':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'bot-chat' };
    case 'settings-bots-onboarding':
      // #1233 deferral: open 远程接入, then let the bot page auto-open the
      // DingTalk detail's scan-login modal (via `botOnboardingProvider`). The
      // e2e-fixture onboarding adapter keeps the session in 'waiting' with a
      // fixed QR + long TTL so the modal's waiting layout is captured
      // deterministically. DingTalk carries a real brand mark (#1236).
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        openSettingsSection: 'bot-chat',
        botOnboardingProvider: 'dingtalk',
      };
    case 'settings-about':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'about' };
    case 'settings-general':
      // PR-SETTINGS-IA-CONSOLIDATE-0: 通用 now also hosts the proxy
      // block that used to live on its own 网络 page.
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'general' };
    case 'settings-memory':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'memory' };
    case 'settings-daily-review':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'daily-review' };
    case 'settings-permissions':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'permissions' };
    case 'settings-voice':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'voice' };
    case 'settings-usage':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'usage' };
    case 'settings-health':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'health' };
    case 'module-skills':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'skills', sidebarCollapsed: false };
    case 'composer-skill-invocation':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        composerText: '/skill:meeting-followup 请整理这次会议的行动项',
      };
    case 'module-mcp':
      // Open the 扩展 → MCP module directly so the alignment audit reaches the
      // real marketplace, command bar, and configured server list.
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'mcp', sidebarCollapsed: false };
    case 'module-daily-review':
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'daily-review', sidebarCollapsed: false };
    case 'workstation-statuses':
      // Active session is the running one so the chat header status
      // badge ("进行中") is visible alongside the
      // sidebar grouping. Each session in the seed maps to one
      // SessionStatus enum value (running / waiting_for_user / blocked
      // × 4 reasons / review / done / archived / aborted (filtered)).
      return { ...state, activeSessionId: WORKSTATION_RUNNING_SESSION_ID };
    case 'plan-reminders':
      // Open the 计划 module directly so the alignment audit reaches
      // the real local reminder MVP: create form + persisted
      // scheduled / paused / completed reminders.
      return { ...state, activeSessionId: TURN_SESSION_ID, sidebarSection: 'automations', sidebarCollapsed: false };
    case 'turn-control-history':
      // Active = primary so the chat surface shows every turn control
      // variant at once: completed baseline, retried pair
      // (forward + reverse badges), regenerated pair, aborted marker,
      // failed banner with generalized Chinese copy. The two branch
      // sessions sit in the sidebar but are not the active surface
      // here — banner positive/negative cases each get their own
      // scenario below so both are covered deterministically.
      return { ...state, activeSessionId: TURN_CONTROL_PRIMARY_SESSION_ID };
    case 'turn-control-branch-visible':
      // Active = visible-parent branch session. Chat header should
      // render the branch banner with copy "分自 ${primary.name}". The
      // primary session in the sidebar is the parent.
      return { ...state, activeSessionId: TURN_CONTROL_BRANCH_VISIBLE_SESSION_ID };
    case 'turn-control-branch-orphan':
      // Active = orphan branch session (parentSessionId points to a
      // session that is intentionally NOT seeded on disk). Chat header
      // must render NO branch banner and NO dead-link button.
      return { ...state, activeSessionId: TURN_CONTROL_BRANCH_ORPHAN_SESSION_ID };
    case 'sidebar-long-sessions':
      // PR-SIDEBAR-IA-0 Phase 1: active = the FIRST session in the seed
      // (newest by lastMessageAt). The 60-session list scrolls below
      // the active row; the fixture exposes the scroll affordance
      // plus the visible footer (Settings + Version info) at the
      // bottom of the sidebar. If the scroll fix regresses, the footer
      // gets pushed off-screen and the regression is visible in the
      // rendered fixture.
      return { ...state, activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00', sidebarCollapsed: false };
    case 'sidebar-search-modal-open':
      // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2):
      // shares the sidebar-long-sessions seed (60 sessions) so the
      // sidebar behind the modal is identical to the long-sessions
      // fixture; `searchModalOpen: true` is the only differentiator.
      // The renderer reads the flag in `applyE2eFixture()` and
      // calls `setSearchModalOpen(true)` before the fixture settles,
      // so the SearchModal shell is on screen deterministically.
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        searchModalOpen: true,
      };
    case 'command-palette-open':
      // PR-shared primitive-COMMAND-INPUT-0: same 60-session seed as the sidebar
      // fixtures; `paletteOpen: true` is the only differentiator so
      // the command palette shell is visible deterministically.
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        paletteOpen: true,
      };
    case 'sidebar-row-actions-visible':
      // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`):
      // same 60-session seed; `focusActiveRow: true` makes the
      // renderer focus the active row's button after mount so
      // `:focus-within` triggers and the overflow action appears.
      // Captures the overflow-trigger state for the overlap gate.
      return {
        ...state,
        activeSessionId: LONG_SIDEBAR_SESSION_PREFIX + '00',
        sidebarCollapsed: false,
        focusActiveRow: true,
      };
    case 'long-transcript':
      // Scroll-geometry contract: boot straight into the 24-turn session so
      // above-viewport turns mount render-skipped (never rendered), the
      // exact state the warm-up + pinned-bottom invariants protect.
      return { ...state, activeSessionId: LONG_TRANSCRIPT_SESSION_ID };
    case 'short-final-turn':
      // Prompt-rail activation contract: boot into the short-tailed session so
      // the spec can scroll straight to an end the activation band never
      // reaches on its own.
      return { ...state, activeSessionId: SHORT_FINAL_TURN_SESSION_ID };
    case 'overflowing-rail':
      // Prompt-rail overflow contract: boot into the 60-prompt session so the
      // rail is already past its cap when the spec scrolls to the end.
      return { ...state, activeSessionId: OVERFLOWING_RAIL_SESSION_ID };
    case 'all':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        sandboxBoundaryBySession: sandboxBoundaryState(),
        liveTurnBySession: {
          ...streamingLiveTurns(),
          ...sandboxBoundaryLiveTurns(),
        },
      };
  }
  // Fallback so the function is total over the scenario union (TS2366); the
  // base state is the safe default for any scenario without a bespoke mapping.
  return state;
}

export async function seedE2eFixture(input: {
  workspaceRoot: string;
  fixture: E2eFixture;
  credentialStore: Pick<CredentialStore, 'setSecret'>;
  now?: number;
}): Promise<void> {
  const now = input.now ?? E2E_FIXTURE_NOW;
  await rm(input.workspaceRoot, { recursive: true, force: true });
  await mkdir(input.workspaceRoot, { recursive: true });
  await resolveStorageRoot({ path: input.workspaceRoot, kind: 'interactive' });
  await writeSettings(input.workspaceRoot, input.fixture.scenario);
  if (input.fixture.scenario === 'first-run') return;
  await writeConnections(input.workspaceRoot, now, input.fixture.scenario);
  for (const slug of ['zai-live', 'relay-fallback', 'empty-fetched', 'needs-reauth', 'broken-provider']) {
    await input.credentialStore.setSecret(slug, 'api_key', `fixture-key-${slug}`);
  }
  await writeSession(input.workspaceRoot, turnSession(now), turnMessages(now));
  if (input.fixture.scenario === 'deep-research-progress') {
    await writeSession(input.workspaceRoot, deepResearchSession(now), deepResearchMessages(now));
    await writeDeepResearchLedger(input.workspaceRoot, now);
  }
  if (input.fixture.scenario === 'task-ledger') {
    await writeTaskLedgerFixture(input.workspaceRoot, now);
  }
  await writeSession(input.workspaceRoot, processingSession(now), processingMessages(now));
  await writeSession(input.workspaceRoot, streamingSession(now), streamingMessages(now));
  await writeSession(input.workspaceRoot, permissionSession(now), permissionMessages(now));
  await writeSession(input.workspaceRoot, errorSession(now), errorMessages(now));
  await writeSession(input.workspaceRoot, artifactSession(now), artifactMessages(now));
  await writeArtifacts(input.workspaceRoot, now, input.fixture.scenario);
  // Stale-session fixture seeds two sessions reproducing the @WAWQAQ
  // workspace state that triggered the P0:
  //   - one healthy ai-sdk session (zai-live, correct slug)
  //   - one fake backend session (FakeBackend)
  // The renderer must mark the unavailable fake Session as stale and leave
  // the healthy Session alone.
  if (input.fixture.scenario === 'stale-sessions') {
    await writeSession(input.workspaceRoot, staleFakeSession(now), staleFakeMessages(now));
    await writeSession(input.workspaceRoot, healthySession(now), healthyMessages(now));
  }
  if (input.fixture.scenario === 'workstation-statuses') {
    for (const seed of workstationStatusSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
  // Scroll-geometry contract (e2e/scroll-geometry.spec.ts): a session tall
  // enough that most turns mount as render-skipped content-visibility
  // placeholders — the state the warm-up and pinned-bottom invariants cover.
  if (input.fixture.scenario === 'long-transcript') {
    await writeSession(input.workspaceRoot, longTranscriptSession(now), longTranscriptMessages(now));
  }
  // Prompt-rail activation contract (e2e/prompt-rail.spec.ts): a scrollable
  // transcript that ends on a turn too short to reach the activation band.
  if (input.fixture.scenario === 'short-final-turn') {
    await writeSession(input.workspaceRoot, shortFinalTurnSession(now), shortFinalTurnMessages(now));
  }
  // Prompt-rail overflow contract (e2e/prompt-rail.spec.ts): more prompts than
  // the rail can show at once, so it scrolls independently of the transcript.
  if (input.fixture.scenario === 'overflowing-rail') {
    await writeSession(input.workspaceRoot, overflowingRailSession(now), overflowingRailMessages(now));
  }
  // PR109f (g): all three turn-control-* scenarios share the same
  // on-disk seed; only the active session selection differs. Seeding
  // the same trio for any of them keeps the fixtures interchangeable
  // for reviewers and lets the `branch-orphan` variant prove the
  // banner stays absent when the parent SessionSummary is missing.
  if (TURN_CONTROL_SCENARIOS.has(input.fixture.scenario)) {
    for (const seed of turnControlSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
  // PR-SIDEBAR-IA-0 Phase 1 (xuan msg `dc790a54` + kenji `0f7bb872`):
  // sidebar-long-sessions seeds 60 active sessions so the sidebar
  // scroll fix is verifiable end-to-end. Each row reuses the standard
  // text content; only the name + timestamp differ so the rendered list is
  // deterministic. The hard gate: with 60 rows in a narrow window, the
  // footer (Settings + Version info) must remain visible without
  // page-level scroll, and the inner list scroll container must work.
  //
  // Phase 2 fixup v3: `sidebar-search-modal-open` shares the same
  // 60-session seed so the sidebar behind the modal matches the
  // long-sessions fixture exactly. The modal-open state itself is a
  // transient renderer flag (`E2eFixtureState.searchModalOpen`); no
  // additional on-disk seeding required.
  if (LONG_SIDEBAR_SCENARIOS.has(input.fixture.scenario)) {
    for (const seed of longSidebarSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
    // Deterministic project record (see LONG_SIDEBAR_PROJECT_ID in
    // seed-helpers): the 按项目 grouping must not depend on the app's async
    // workspace self-registration. The location points at the live
    // workspace root so the catalog presents it as available.
    await writeJson(join(input.workspaceRoot, 'projects.json'), {
      schemaVersion: 1,
      projects: [
        {
          id: LONG_SIDEBAR_PROJECT_ID,
          name: LONG_SIDEBAR_PROJECT_NAME,
          identity: `folder:${input.workspaceRoot}`,
          locations: [
            { path: input.workspaceRoot, isWorktree: false, lastUsedAt: now },
          ],
          lastUsedAt: now,
        },
      ],
    });
  }
  if (input.fixture.scenario === 'plan-reminders') {
    await writePlanReminders(input.workspaceRoot, now);
  }
  if (input.fixture.scenario === 'module-daily-review' || input.fixture.scenario === 'settings-daily-review') {
    await writeDailyReviewArchives(input.workspaceRoot, now);
  }
  if (input.fixture.scenario === 'module-skills') {
    await seedSkillsMarketFixture(input.workspaceRoot);
  }
  if (input.fixture.scenario === 'composer-skill-invocation') {
    await seedSkillsMarketFixture(input.workspaceRoot);
  }
  if (input.fixture.scenario === 'module-mcp') {
    await seedMcpFixture(input.workspaceRoot);
  }
  // Settings → 使用统计: seed extra model + tool traffic so the request log,
  // provider / model / tool aggregates render real content in the fixture.
  // Scenario-gated so no other fixture's sidebar or usage totals shift.
  if (input.fixture.scenario === 'settings-usage') {
    for (const seed of usageStatsSessions(now)) {
      await writeSession(input.workspaceRoot, seed.header, seed.messages);
    }
  }
  await seedSessionProjects(input.workspaceRoot);
}

/**
 * Resolve every seeded session's project here rather than leaving it to the
 * startup backfill. The fixture is meant to hand the renderer a settled state:
 * the app resolves projects in background startup, concurrently with window
 * creation, so a test that asserts on project grouping would otherwise be
 * racing the resolver instead of exercising the sidebar.
 */
async function seedSessionProjects(workspaceRoot: string): Promise<void> {
  const sessions = createSessionStore(workspaceRoot);
  const catalog = createProjectCatalog(workspaceRoot);
  try {
    await backfillSessionProjects({ sessions, catalog });
  } finally {
    await sessions.close?.();
    catalog.close();
  }
}
