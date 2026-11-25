# Extra

The modules of `nsh-extra`, NSH's official modules that an app installs with `nsh add` rather than every app
carrying them. `nsh.json` lists the crate in `"dependencies"` by path, with the features this example uses, and
`App.tsx` imports them from `nsh-extra`:

```tsx
import { Speech } from "nsh-extra";
```

| Feature | What the example shows | Tests |
|---|---|---|
| `speech` | Dictation: a session with interim transcripts, stopped or aborted (`App.tsx`) | `tests/speech.test.tsx`, with the module's fake recognizer speaking for the user (`app.fake("nsh-extra/speech", "hear", [text])`) |

```sh
nsh run examples/extra
nsh test examples/extra
```
