# Post editor

A prototype of Longbridge's short post editor on `RichEditor`: type, insert tags, write the HTML the server stores and
read it back to keep editing. The host's search APIs are fake data (`host.ts`).

| Part | Where |
|---|---|
| The inline atoms `securityTag`, `mention`, `hashtag`, each with its `parse_dom` and `to_dom` in the web's format, the `$` `@` `#` suggestions and the press that selects a stock tag | `native/src/tags.rs` |
| The weighted length (the rule of `@web/utils`' `content-limit-rules.ts`), as the module `PostLength` | `native/src/weighted.rs` |
| The page: suggestion list, trend menu, `getHTML()` output, HTML read back with `setContent(html, "html")` | `App.tsx` |
| Round trips of every tag, the length rule | `native/tests/post_editor/`, `native/src/weighted.rs` |
| The page's behavior, headless | `App.test.tsx` |

## The HTML

The format is the web's (`longbridge-websites` `packages/blocks/src/social`: `editor/html-parsers.ts`,
`utils/parse-trend.ts`, `utils/format-comment-html.ts`, `rich-text/index.tsx`, and their tests):

| Node | HTML |
|---|---|
| `securityTag` | `<span type="security-tag" counter_id="ST/US/AAPL" name="Apple Inc." trend="1"></span>` |
| `mention` | `<span type="mention" member_id="1001" name="Alice">@Alice</span>` |
| `hashtag` | `<span type="hashtag" name="Earnings" value="#Earnings#">#Earnings#</span>` |

- **Stock tag**: the span is empty (the web's fixtures) and the editor shows `$name`. `trend` is `"0"` neutral, `"1"`
  bullish, `"2"` bearish, absent until picked (the menu on a pressed tag sets it, undoably); another value reads as
  absent. A missing `name` becomes the code of the `counter_id`.
- **`counter_id`**: the web's `resolveCounterIdFromQuote` writes the search result's `counter_id` as it is, three
  segments `TYPE/MARKET/CODE` (`ST/US/AAPL`, `ST/HK/700`); only for a quote without one it falls back to two,
  `MARKET/CODE` (`HK/700`), which `parseQuotesFromHTML` splits. The fake search returns three segments and the
  editor writes what it gets; reading keeps either as it came.
- **Mention**: `type="mention"`, `member_id`, `name`, the text `@name`. Reading also takes `[data-mention]` with
  `data-user-id` / `data-id`, a missing `member_id` as the name and a missing `name` as the text without `@`.
- **Hashtag**: the web editor writes none: a picked topic is a separate `hashtags` list, so `#` here takes the `#`
  away and adds a chip. The node reads and writes the form the server renders (`name`, or `value="#name#"`), for
  content that has it.
- **Count**: the weighted length of the HTML's text, as the web counts, so an empty stock span adds nothing.

```sh
./target/debug/nsh test examples/post-editor        # the Rust and TSX tests
./target/debug/nsh run examples/post-editor --target web
```

On macOS the web target needs an LLVM `clang` for WebAssembly: `CC_wasm32_unknown_unknown` and
`AR_wasm32_unknown_unknown` at Homebrew's `llvm` (`docs/dev/web.md`).
