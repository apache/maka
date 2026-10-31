# Browser JavaScript size measurements

Measured on 2026-10-27 against main `8df71d2a1cbc6bea72596fa10b2946f60c64bc49` (including #429).
Both builds use the same Counter/Gallery sources, release packaging, `web` profile (`opt-level=z`, fat LTO,
stripping, aborting panics), wasm32 target and compiler flags. Native QuickJS behavior and the embedded
bytecode player remain available. This change replaces the standalone Web execution host.

Toolchain: Rust 1.99.1 (`58cf8f9c3`, LLVM 23.1.1), clang/LLVM 19.1.7, Node 24.19.0,
Chromium 151.0.7922.173 on Linux x86_64. The CLI was built in the dev profile; it explicitly builds Web
runtimes with the `web` profile. `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0`, four Cargo jobs.
No post-link wasm-opt pass was applied. #429's `web-dev` profile remains the custom Rust development path.

## Shipped code

All sizes are **decimal bytes**. Totals include every shipped Wasm, JavaScript and bytecode file, including
optional chunks. Each file is independently compressed with gzip level 9 and Brotli quality 11. Fonts,
images, HTML and HTTP overhead are excluded. These are calculated transfer sizes, not a claim that the local
static server sends compressed responses.

| Workload | Raw | Gzip | Brotli |
|---|---:|---:|---:|
| Counter before | 16,159,518 | 5,632,521 | 4,221,196 |
| Counter after | 12,540,474 | 4,539,436 | 3,425,833 |
| Gallery before | 16,937,823 | 5,976,278 | 4,509,345 |
| Gallery after | 13,100,520 | 4,724,712 | 3,589,333 |

Counter saves 795,363 Brotli bytes (18.8%). Gallery saves 920,012 Brotli bytes (20.4%). The 1,000,000-byte goal is **not reached**.

The identical Wasm is shared by both workloads:

| Runtime | Raw | Gzip | Brotli | SHA-256 |
|---|---:|---:|---:|---|
| before | 16,033,104 | 5,590,605 | 4,184,566 | `72f08eb1052d7e03a26671c86de9fd5bf480657dc66a1beb24265dffdb2812ee` |
| after | 12,326,969 | 4,463,394 | 3,358,422 | `d6520ee8d3cdf3b1594405916e98a8d2f549c59d255468e2a0b1d63f1b21a1db` |

Cold navigation was recorded in fresh Chromium pages until the app started and its default Stocks screen
loaded, plus one second. The initial/optional split below uses observed request URLs, not an assumption
that every Gallery screen downloads at startup. Counter requests all its shipped code initially.

| Gallery | Initial raw | Initial gzip | Initial Brotli | Optional raw | Optional gzip | Optional Brotli |
|---|---:|---:|---:|---:|---:|---:|
| before | 16,303,701 | 5,693,613 | 4,272,416 | 634,122 | 282,665 | 236,929 |
| after | 12,642,865 | 4,570,722 | 3,453,617 | 457,655 | 153,990 | 135,716 |

## What remains

Production code/data sections are 9,086,303 / 3,167,393 raw bytes. A second link with names and an LLD map
attributes the largest remaining groups below. Its code section is byte-identical to production. Its data
section has the same length, differing only in 15 characters of a generated html5ever build-directory path.
Build-directory hashes can also cause small compressed-size variance across clean builds.

These are independently compressed groups, **not additive contributions to the whole-file compressed size
and not guaranteed removable bytes**. LTO can merge/in-line functions; grouping by a surviving symbol or
archive is attribution, not a proposed feature removal.

| Group | Raw bytes | Independent Brotli bytes |
|---|---:|---:|
| `data:two_face` | 922,018 | 801,338 |
| `code:nsh_core` | 2,067,437 | 396,132 |
| `code:nsh_base` | 1,804,285 | 387,713 |
| `data:brotli` | 550,833 | 210,690 |
| `code:core` | 877,729 | 152,214 |
| `code:naga` | 554,440 | 141,324 |
| `code:alloc` | 737,621 | 105,549 |
| `code:regex_automata` | 279,082 | 69,772 |

QuickJS is absent from the browser feature's normal dependency graph (`nsh-js`, `rquickjs` and
`rquickjs-sys` are absent), and the artifact exports the browser bridge without `nsh_start_bytecode`.
Since then every web runtime (development host, website demos, playground) runs on the browser engine.
The measured whole-runtime reduction includes replacing NSH's QuickJS bindings and standard-library
integration; it must not be presented as the C interpreter's standalone size.

Reaching below 1 MB while retaining all APIs needs another architectural step: load syntax data and
expensive component/shader/compression implementations on demand, or specialize a runtime to an app's
reachable component set. The current native registry keeps registered component code linked even when
its JavaScript module is lazy. Ordinary JS chunk splitting cannot remove that native payload. Removing
languages, components or synchronous compression APIs would be a product tradeoff and is not done here.

## Reproduction and validation

Use separate checkouts at the baseline and this PR, with the same toolchain/environment:

```sh
cargo build -p nsh-cli
target/debug/nsh package examples/counter --target web -o /tmp/nsh-counter
target/debug/nsh package examples/gallery --target web -o /tmp/nsh-gallery
node crates/nsh-platform-web/web/browser/package-size.mjs /tmp/nsh-gallery/Gallery --require-browser --brotli-budget=4000000
```

The baseline does not have the measurement script; use this PR's script against its output, omitting
`--require-browser`. To separate initial/optional code, pass `--requests=requests.json`, an array of URLs
recorded during cold navigation. The CI 4 MB ceiling detects regressions; it is not the 1 MB design target.

Validated locally:

- Supported CLI Counter and Gallery packages before/after, including Counter increment/decrement/history.
- Thirteen Gallery screens render, including Shaders. Nine interaction flows pass before/after: standard
  utilities/files/environment, list scroll-to-index, modal open/Escape, form editing/submission, table jump
  to row 500,000, animation replay, press events, alert cancellation and editor input.
- Custom RustExports package: constructors and `using`, callback updates, class transfer/property setter,
  async module/class calls, disposed-class errors and the typed Gauge component's change event.
- 39 actual-Wasm bridge tests; Chromium realm/host-event/startup/replacement/disposal checks, including
  failing module loads, throwing cleanup and reentrant error handling. A new `tests/compat` case checks
  Buffer/error brands, cleanup identity and nextTick on native and packaged browser hosts.
- Native engine: 312 tests, five ignored, plus its doctest. CLI: 86 passed, one ignored. Browser and
  engine/CLI/xtask Clippy clean; nightly workspace formatting and CI dependency-path checks pass.
- Independent read-only review covered ownership, stale handles, callbacks, promises, error boundaries,
  lifecycle and packaging. Findings were fixed and regression-tested.

Native Counter `nsh test --trace` retains 49 mount items initially and seven after +1. One local sample:
commit 611 → 588 microseconds; press commit 383 → 364 microseconds. These small timing differences are
noise, not a claimed native speedup. Browser cold loads made more small requests (Counter 5 → 29,
Gallery 9 → 35 including non-code requests); network latency and large-graph tracing cost need broader
profiling. Conservative cross-heap tracing and Chromium tests do not establish exhaustive GC or cross-browser parity.

Validation limits: full workspace tests stop at missing `glib-2.0.pc`; the separate `nsh-compat` harness
fails to compile against current upstream APIs (42 errors, including removed style fields and missing
`PropEnum` import). Existing web tests pass 33/37; four Chromium `--dump-dom` tests time out in this
container, and the two text tests also time out on the pinned baseline. Playwright checks above pass.
No macOS/iOS/Android device validation was performed. CI results are recorded on the PR at its exact head.

Implemented with ChatGPT assistance and reviewed by a separate ChatGPT reviewer.
