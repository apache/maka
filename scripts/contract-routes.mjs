// Shared route manifest for the #1565 migration harnesses.
//
// check-visual-contract.mjs and check-hit-test.mjs used to carry their own
// copies of this table. Two copies of "what the five representative routes
// are" is exactly the kind of duplication the surface slices (PR 8–10) would
// have had to edit twice, in the same commit, without a conflict to warn
// them — so the table lives here and both scripts import it.
//
// Ready selectors are structural hooks, not product classes. A product class
// is what the migration deletes: keying the harness on `.settingsRows` means
// the slice that replaces settings rows must edit the harness in the same
// breath, re-coupling surfaces through test infrastructure. `data-maka-contract`
// carries no styling and no behavior; it exists only so the harness can find
// the same element on both sides of a migration.
//
// Migration-only scaffolding: removed in PR 11 with the rest of the harness.

/** The attribute the harness owns. Product CSS must never key on it. */
export const CONTRACT_HOOK = 'data-maka-contract';

/** Selector for a named contract hook. */
export const hook = (name) => `[${CONTRACT_HOOK}="${name}"]`;

// The five representative routes from #1565. The issue names product routes;
// these are the MAKA_E2E_FIXTURE scenarios that actually open them on main —
// there is no scenario literally named "settings-providers" or "chat".
// `ready` is the element that means "this surface has rendered". Without it
// the only alternative is a fixed sleep, which captures a half-mounted route
// as a clean one on a slow machine — and writes that into the baseline.
//
// Each ready selector is `hook, legacy-class`: the visual contract boots the
// BASE ref with the same selector, and a base that predates the hook rollout
// (main before PR 2) only has the class. The compound is self-healing in both
// directions — after PR 2 merges the hook matches every base, and when a
// slice later deletes the legacy class the hook keeps matching.
const ready = (name, legacy) => `${hook(name)}, ${legacy}`;
export const ROUTES = [
  // Chat session with the task workbar open.
  {
    id: 'chat',
    scenario: 'turn-narrative',
    ready: ready('session-workbar', '.maka-session-workbar'),
  },
  {
    id: 'settings-general',
    scenario: 'settings-general',
    ready: ready('settings-rows', '.settingsRows'),
  },
  // Providers live under the 模型 settings section.
  {
    id: 'settings-providers',
    scenario: 'provider-workspace',
    ready: ready('providers-panel', '.providersPanel'),
  },
  // The hook sits on the module <main>, not the PageHeader inside it —
  // PageHeader takes an explicit prop list and forwarding a harness attribute
  // through a shared primitive is not worth the API change; the <main>
  // renders in the same commit as its header.
  {
    id: 'mcp-hub',
    scenario: 'module-mcp',
    ready: ready('module-main', '.maka-module-main-header'),
  },
  // Empty profile, first launch.
  {
    id: 'onboarding',
    scenario: 'first-run',
    ready: ready('onboarding-surface', '.maka-onboarding-surface'),
  },
];

export const THEMES = ['light', 'dark'];

// #1565 asks for darwin AND win32: the per-OS CSS is keyed off
// `html[data-os]`, so a regression under the win32 cascade is invisible in a
// darwin-only capture for the whole migration. The fixture platform override
// flips `data-os` through the production path on any host.
export const PLATFORMS = ['darwin', 'win32'];
