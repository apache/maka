# Component benchmarks

The screens of the component benchmark with `TsButton.tsx`, a Button written in TSX (drawn exactly like the Rust
Button of the benchmark's own UI set, `test/ui`, with the default theme):

- `GridTs.tsx`: 200 Buttons in a scroll view; the first press target updates every title.
- `RowsTs.tsx`: a recycled list of 1000 rows with a Button each.

`cargo test --release -p nsh-engine --test engine bench_components -- --ignored --nocapture` prints the JS and core
time of each screen with both Buttons; `nsh test examples/bench/GridTs.tsx --trace` shows the mount items. Results:
`docs/dev/performance.md`.

`Inputs.tsx` holds the input controls' hot paths: a searchable Select of 10 000 items, a TimeField, a NumberInput and
an OtpInput. Steps on standard input drive them, `--trace` shows each keystroke's commit, e.g.
`echo 'await app.press("Pick"); await app.type("Search", "4"); await app.type("text:4", "2")' | nsh test examples/bench/Inputs.tsx --trace`.
