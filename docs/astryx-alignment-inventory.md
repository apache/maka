> **Superseded for file-level coverage:** see [astryx-surface-file-inventory.md](./astryx-surface-file-inventory.md) (one row per product surface file). This document remains the family-level wiki map and fix log from the first alignment pass.

# Astryx alignment inventory

Maps [Astryx wiki](https://github.com/facebook/astryx/wiki) conventions onto
Maka product surfaces. Severity: **blocker** (raw control when an Astryx twin
exists / broken hierarchy) · **polish** (off-scale px, density).

## Wiki smell checklist (searchable)

| Area | Smell | Prefer |
|------|-------|--------|
| Design · spacing | Off-grid `px` not on `--space-*` | Spacing tokens |
| Design · size | Fixed control height ≠ 28 / 32 / 36 | `size` / density props |
| Design · radius | Nested radii not `outer − gap` | Role radii |
| Design · elevation | Raw `box-shadow` / magic z-index | Elevation tokens |
| API · Use the System | Raw `<button>` / `<input>` / `<select>` with Astryx twin | `Button`, `TextInput`, `Selector`, `List`/`Item`, `EmptyState`, `Dialog`, `ToggleButton`, `Collapsible`, `SegmentedControl` |
| Theming | One-off hex for ladder roles | Bridge + product tokens |
| Container padding | Product padding fighting `--container-padding-*` | Let Card/Section/Layout own inset |

## Surface families

### Settings shell
| Surface | Fit | Gaps | Status |
|---------|-----|------|--------|
| `SettingsPage` / `SettingsSection` | High — Heading/Text/HStack open-row idiom | Kit uses `div`+grid (documented) for minmax column | already aligned |
| Settings modal / route header | High — Dialog patterns | — | already aligned |
| Settings rows / expandable | Medium | Product CSS for row chrome | polish |

### Settings pages
| Surface | Gaps | Status |
|---------|------|--------|
| General, Appearance, Data, Providers, Bot, Memory, Permission, Health, About, Usage, Web search, Projects, Subagent, Daily review | Primary actions mostly Astryx `Button`; EmptyState where needed | already aligned |
| Provider catalog / bot overview | `Item` rows | already aligned |

### Module hubs
| Surface | Gaps | Status |
|---------|------|--------|
| `ModulePage` (Layout/Header/Content/Panel) | Vendor layout | already aligned |
| Skills / MCP / Scheduled tasks / Daily review | EmptyState + List + Toolbar | already aligned |
| Module list skeleton rows | `min-height: 42px` off rhythm (not page-bar) | **fixed → 36** |

### Shell / chat chrome
| Surface | Gaps | Status |
|---------|------|--------|
| App shell / session list | SideNav | intentional raw siblings where nested button forbidden |
| Composer | Raw hint/cancel buttons | **fixed → Button** |
| Workbar tabs | Raw `role=tab` + dnd-kit | intentional (dnd + tablist; close is IconButton) |
| Workbar tool picker | Product-authored menu semantics and row chrome | **fixed → List + ListItem** |
| Inspector failed filter | Raw toggle | **fixed → ToggleButton** |
| Plan execution panel | Raw expand toggle | **fixed → Collapsible** |
| Titlebar identity | BreadcrumbItem | already aligned |

### Dialogs / overlays
| Surface | Gaps | Status |
|---------|------|--------|
| External session import | Raw source + row buttons | **fixed → SegmentedControl + Item** |
| Session rename / command palette | Dialog/Astryx | already aligned |

### Panels
| Surface | Gaps | Status |
|---------|------|--------|
| Task ledger | Row min-heights 30/34 | **fixed → 32** |
| Quote / prompt rail chips | Raw expand/remove | polish (chip hit geometry) |

## Fixed in this pass
- Control-height rhythm: task ledger rows/triggers and module list skeleton rows.
- Composer no-model / revision cancel → Astryx `Button`.
- Inspector failed-only filter → Astryx `ToggleButton`.
- External import source + session pick → `SegmentedControl` / `Item`.
- Plan execution expand → Astryx `Collapsible`.
- Workbar tool picker → Astryx `List` + `ListItem`; visible descriptions and native row interaction.
- `scripts/check-astryx-alignment.mjs` + unit test gate.

## Remaining polish (non-blocker)
- Quote chips / prompt-rail ticks stay product-shaped hit targets.
- Workbar tab strip stays custom for dnd-kit + `role=tab`.
- Nested button prohibition on SideNavItem endContent (documented intentional).
