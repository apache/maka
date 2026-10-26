# Developer documentation

For people working on NSH itself (`AGENTS.md` at the root is the short version agents read first).

| Page | What |
|---|---|
| [architecture.md](architecture.md) | Threads, the data flow from JS to native views, crates |
| [native-pipeline.md](native-pipeline.md) | How apps are compiled and run: the JSX compiler, the native modules, the renderer, types, hot reload |
| [js-modules.md](js-modules.md) | The modules (`nsh`, `nsh/*`, apps' UI sets), where each module is implemented and declared, platform props, where new things go |
| [api-naming.md](api-naming.md) | API names: how TSX names follow `gpui-base`'s, the conventions, the renames |
| [components.md](components.md) | Rust components (`nsh/base`'s, apps' UI sets): writing one, the host node, bindings, children and slots, events, the JS face and declarations |
| [reactive-components.md](reactive-components.md) | Rust components on the shared reactive graph (run once, fine-grained bindings, no diff) |
| [elements.md](elements.md) | Host elements and `nsh/base`'s components, touch, accessibility, the environment, why the main thread never waits for JS |
| [text.md](text.md) | Text blocks, spans, inline attachments |
| [text-view.md](text-view.md) | `TextView` (`nsh/base`): Markdown, HTML and documents shown with the primitives, streaming, parts, extensions |
| [dock.md](dock.md) | `DockArea` and `ResizablePanelGroup` (`nsh/base`): the layout data, render keys keeping panels across moves, drag and drop, compact presentation |
| [diff.md](diff.md) | `DiffView` (`nsh/base`): the line diff, pairing and inline changes, rows and separators, patches, highlighting, parts |
| [editor.md](editor.md) | `Editor` (`nsh/base`): the code editor's model, display rows, input and keys, virtualization, incremental highlighting, search, diagnostics, folds, parts |
| [styles.md](styles.md) | Tailwind, effects, view styles, Android differences |
| [geometry.md](geometry.md) | Units and geometry (`nsh_core::geometry`, as GPUI's): the types, the conversion boundaries, the `unit_types` check, the migration |
| [scrolling-and-lists.md](scrolling-and-lists.md) | Scroll views, zooming, `List` |
| [animation.md](animation.md) | Animated values, composites, layout animation |
| [canvas.md](canvas.md) | `Canvas` |
| [images.md](images.md) | Loading, decoding, caching, animated images |
| [sandbox.md](sandbox.md) | VM limits, hardening, capabilities |
| [signed-packages.md](signed-packages.md) | Keys, packages, verification, revocation |
| [embedding.md](embedding.md) | `nsh package`, the iOS / Android SDKs, native components |
| [layerfs.md](layerfs.md) | Opt-in Linux development and CI trial: Git, Cargo, snapshots and receipts |
| [tooling.md](tooling.md) | `.nsh/types`, the dev server, hot reload, symbolication |
| [macos.md](macos.md) | The macOS backend (AppKit): building, how each area maps to AppKit, `nsh test --target macos`, what differs |
| [linux.md](linux.md) | The Linux backend (GTK 4): building, how each area maps to GTK, `nsh test --target linux`, what differs |
| [windows.md](windows.md) | The Windows backend (Win32, Direct2D): building, how each area maps to Windows, `nsh test --target windows`, what differs |
| [gpui.md](gpui.md) | The GPUI backend (macOS, Windows, Linux): building, the surface element and `DrawCx`, embedding as a GPUI view, what differs |
| [tui.md](tui.md) | The terminal backend (Ratatui): cell metrics, retained rendering, input, graphics, embedding and scripts |
| [web.md](web.md) | The WebAssembly runtime of the website's demos: `LocalEngine`, the clock, the DOM protocol |
| [compatibility.md](compatibility.md) | The backward compatibility contract: what apps depend on, the rules, `nsh-compat` and `tests/compat/` |
| [performance.md](performance.md) | Baselines |
| [pitfalls.md](pitfalls.md) | Verified constraints and pitfalls, by area |

How a module works inside is documented in the module itself (`//!` docs, Javadoc); these pages describe behavior
and decisions and point there.
