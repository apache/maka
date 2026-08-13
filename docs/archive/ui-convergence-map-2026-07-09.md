# UI Convergence Map (2026-07-09)

> Archived on 2026-07-13. The campaign is complete; current ownership lives in the frontend READMEs, source, and contract tests.

Maintainer complaint: shared UI solutions re-implemented per call site. This map inventories
every duplicated recipe family and the extraction sequence. Produced by a read-only audit
agent; token layer (--state-hover-bg/--state-selected-bg, Chip alphas, tabular-nums) is
already contract-governed — the work is moving STRUCTURE onto shared primitives.

## Prioritized extraction sequence

1. **Chip expansion + CSS-label migration** — 7+ hand-rolled tone→alpha tables collapse into
   primitives/chip.tsx. Order: primitive-free CSS labels first (maka-skill-library-status-label,
   maka-scheduled-task-run-status, maka-daily-review-archive-status), then settingsAuthActionPill
   (connection.css:160-227), settingsBotStatusPill (bot.css:189-213, add `dot` prop),
   providerCatalogBadge.is-state (models.css:193-198). chip-converge-contract.test.ts already
   pins the target alphas (/12 /14 /18 /15). Badge stays pill-role (badge-converge contract).
2. **Item adoption for list rows** — primitives/item.tsx already encodes 4%/8% fills; add a
   `selected` prop → --state-selected-bg; migrate enabledConnRow, providerCatalogRow,
   maka-skill-library-row, daily-review archive/session rows, settingsOsPermissionRow.
   HIGH contract risk: sidebar-topbar-rail / model-oauth-section / skills.test.ts pins;
   state-token-governance-499 rejects any non-token fill introduced during migration.
3. **PageHeader primitive** — module h2 shells (maka-module-main-header, maka-scheduled-task-hero) +
   settings h3 intros (settingsPermissionIntro, settingsHealthIntro, settingsFeatureStatusHero,
   settingsAboutHero). API: title/subtitle/icon/eyebrow/as('h2'|'h3')/actions/meta. Keep class
   hooks for renderer-module-styles + tailwind-compile contracts.
4. **StatTile** — permission.css:547 tile ≈ health.css:118 tile (near-identical); fold
   settings-metric-card.tsx MetricCard + daily-review totals cell. outline|filled emphasis.
   Must bake in tabular-nums (tabular-nums-converge contract).
5. **SectionHeader + ActionRow (+ EmptyState inline variant)** — three section-header dialects
   (maka-skill-section-row / maka-daily-review-section-title with ::before accent bar /
   settingsPermissionSectionHeader); action rows: settingsActionRow already shared, fold
   maka-module-main-actions / maka-scheduled-task-top-actions / maka-daily-review-actions.

## Status
- [x] 1 Chip — SHIPPED #681 (5 recipes retired, dot prop added, contract extended)
- [~] 2 Item rows — round 2 shipped on feat/item-row-convergence: Item gained
      `selected` (→ --state-selected-bg) + `interactive` gate. Migrated
      enabledConnRow (data-default → selected) and daily-review archive rows
      (UiButton → Item). providerCatalogRow already on Item. DEFERRED with
      reasons: enabledProviderTrigger (accordion header, not a row),
      settingsOsPermissionRow (static grid + stripe, pinned grid/div-actions),
      daily-review session rows (composite: preview sibling outside the button),
      maka-skill-library-row (bespoke grid + parent-li hover, skills.test.ts
      pin — interactive={false} support landed for a future adoption).
- [x] 3 PageHeader — SHIPPED on feat/page-header-convergence: new
      primitives/page-header.tsx (title/subtitle/eyebrow/icon/badge/
      as('h2'|'h3')/actions/meta + contentClassName/iconClassName/
      headingRowClassName/subtitleClassName/as_wrapper escape hatches).
      Migrated all 6 call sites: skills-panel maka-module-main-header,
      scheduled-task-panel maka-scheduled-task-hero (contentClassName=maka-scheduled-task-heading),
      permission-center settingsPermissionIntro (meta), health-center
      settingsHealthIntro (meta + <strong> subtitle), voice-settings
      settingsFeatureStatusHero (icon + 本地自检 badge), about-settings
      settingsAboutHero (icon + version/channel badge fragment + h2 scale).
      NO CSS re-pin needed: every wrapper's typography CSS uses DESCENDANT
      selectors (`.wrap h2/h3/p`) that keep matching through the primitive's
      slot divs; radius/pruning contracts untouched (wrapper blocks
      unchanged). check-a11y: added `Maka` to the brand allow-list (About
      title prop tripped english-aria-label). Verified: ui+desktop builds,
      2293 desktop / 46 ui tests, dead-css clean, alignment audit clean,
      5 CDP captures in notes/round3-page-header-captures/.
- [x] 4 StatTile — SHIPPED #701 (inline after agent cancellation; --font-size-stat ladder step added)
- [x] 5 SectionHeader (#703) + EmptyState inline (#704). ActionRow intentionally CLOSED: settingsActionRow already shared across 9 pages; the 3 module clusters carry distinct pinned layouts where a primitive adds a hook without removing duplication.

CAMPAIGN COMPLETE 2026-07-10: every family has one primitive + contract pins + the CI alignment auditor.

(Details per family — implementations with file:line, divergences, risks — are in the audit
agent's report; the essentials are inlined above. Update checkboxes as rounds ship.)
