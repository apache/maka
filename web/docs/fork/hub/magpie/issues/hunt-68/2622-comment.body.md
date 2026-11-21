I'm the one who claimed this on Oct 16 and withdrew the same day when 72d6103e landed (comment 4). jinyue806's Oct-17 root-cause correction has had no local verification since, so I ran it against current main (`3b8bcc36`, which contains 72d6103e; nothing between the Oct-23 baseline and now touches this path). Summary: **the Oct-17 finding checks out at the request-shape level, and 72d6103e does not cover it — the wrapper half of the original report is fixed, the schema half still goes upstream as it came.**

### What main sends upstream for the Oct-17 minimal repro

I drove the gateway's own HTTP handler end-to-end against a recording fake upstream, with a provider whose Chat base points at it (SenseNova's case: no Kimi/OpenRouter/Cline preset, plain host). A Chat request whose tool is already in the Chat shape with jinyue806's minimal schema

```json
{"type":"object","properties":{"x":{"type":"array","items":{"$ref":"#/$defs/T"}}},"$defs":{"T":{"oneOf":[{"type":"string"}]}}}
```

reaches the upstream with `tools[0].function.parameters` **byte-identical** to what the client sent. The same schema sent in the MCP shape the report describes (`{"name":"observe_native_calls","inputSchema":…}`) comes out wrapper-normalized and schema-verbatim:

```json
{"function":{"name":"observe_native_calls","parameters":{"type":"object","properties":{"x":{"type":"array","items":{"$ref":"#/$defs/T"}}},"$defs":{"T":{"oneOf":[{"type":"string"}]}}}},"type":"function"}
```

Nothing else in the outbound chain inspects schema content for such a host. Every schema-content transform in `forwardOnce` (internal/gateway/gateway.go:3932-3937) is host-gated: `toolOneOfAsAnyOf` applies to Cline/Kilo/openrouter.ai only (oneof_schema.go:19), `kimiToolEnumTypes`/`kimiToolRefTypes` to Moonshot/Kimi hosts and presets only (kimi_schema.go:66), `deepseekToolPatterns`/`grokToolPatterns` to their own hosts. Probes asserting each returns the body unchanged for a SenseNova-shaped provider pass on current main, and the request's controls (the inlined `oneOf`, a `$ref` to a plain object) ride through just as verbatim — magpie discriminates no schema here.

So, the three questions this thread left open:

- **(a) Does the Oct-17 root cause still produce the bad shape on main?** Yes — the `$ref`-to-`oneOf` schema reaches a Chat upstream unchanged.
- **(b) Is that the reporter's 400?** It is the surviving half of it. Per the routing-log A/B in comment 2 and yetone's commit message, the five failed requests carried both defects at once: MCP-shaped wrappers relayed as they came (the `Tools[0].Type invalid` half) and these rea schemas (the `$ref` half). jinyue806's own controls hold the wrapper constant and flip only the schema (inlined `oneOf` 4/4 pass vs `$ref`→`oneOf` 4/4 fail), so the schema defect is causal in its own right; 72d6103e removed only the wrapper half. I cannot re-run the upstream experiments (no SenseNova key) — the 4/4 rejections remain jinyue806's evidence — but if they hold, a retest with any of the four rea tools attached would still be turned away, while a retest without them would pass and never exercise this shape.
- **(c) What does shapeChatTools do here?** Wrapper-only normalization: name/description/strict plus `parameters` (taken from `parameters`/`inputSchema`/`input_schema`) moved into a `function` object with `type:"function"` added (chat_tool_shape.go:23). The parameters content is carried as a raw JSON value with zero schema inspection, and a request whose tools are all already in the Chat shape is returned byte-for-byte. It runs at the two choke points (handle, gateway.go:1465, and parseChat, chat.go:78).

### On the Oct-17 comment, point by point

- **True root cause = a `$ref` whose `$defs` target holds `oneOf`/`anyOf`**: confirmed at the shape level above; the upstream behavior itself I could not re-run.
- **No contradiction with the report body's "schemas including `$defs`+`$ref` all returned 200"**: that earlier test exercised a plain `$ref` and never hit the `$ref`→`oneOf` combination.
- **"The outer `inference request is invalid` text is magpie's fallback"**: this point I'd correct — that string, and the `reason=unknown retryable=false` suffix, appear nowhere in magpie's code; as yetone wrote in comment 3, it is the client's own wrapper around the upstream error. magpie's 400 path relays the upstream body, as the report's own first reproduction shows (`field Tools[0].Type invalid` came through).
- **The suggested fix (inline the `oneOf`/`anyOf` at the use site)**: nothing to add on the approach itself; recording only that the nearest in-tree relatives are narrower and different in kind — `kimiToolRefTypes` (129d8b08) writes a `type` into untyped `$ref` targets for Kimi hosts and deliberately leaves `anyOf` targets alone, and `toolOneOfAsAnyOf` renames `oneOf`→`anyOf` in place for Cline/Kilo/OpenRouter. Neither covers plain OpenAI-compatible hosts, and neither inlines. (Rea's zod-style `__schema0`/`__schema1` `$defs` are the same family the Kimi fix was written for, incidentally.)

### Siblings with the same exposure

The same schema rides the translations untouched: the Messages route sends it as `tools[0].input_schema` and the Responses route as `tools[0].parameters` (asserted equal to the input). The Anthropic-side root-combinator handling (`objectSchema`, anthropic.go:1678, from #646) only merges `anyOf`/`oneOf`/`allOf` at the schema root, so a `$ref`→`oneOf` under `items` passes through there too; whether Anthropic's API takes it I did not test. Any strict OpenAI-compatible Chat host is in SenseNova's position; the per-host patch family (Kimi's ref types, xgrammar's oneOf, DeepSeek/Grok patterns) so far grows one report at a time.

### Question

Before this closes on a retest: would it make sense to include rea's four tools (or the minimal schema above) in it? If the Oct-17 upstream experiments hold, a retest that omits them passes without exercising the surviving shape. And if a fix is wanted here, is the preference a per-host patch like the Kimi one (type insertion — unverified whether SenseNova's validator would take it), or the inlining jinyue806 suggests?

Not verified here: the real SenseNova upstream (no key), the routing-log history in comment 2, and the 3/4 non-deterministic `$ref`-to-plain-object case. `go vet` on the touched package is clean; the checks above were request-shape assertions against `3b8bcc36`.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
