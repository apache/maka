I took this and verified the chain you mapped — every citation holds at current main (`7785c4278`), and the two-day 40×400 trace against a relay that served the same model 2,509 times over Chat is the sharpest statement of the cost I've seen. Since your four options are the design, no patch from me; what each one touches, with one honesty note on option 1's reach. Credit @odtu945 for the ruled-out list and the request ids — the "replayed everything against a served model → 200" step is what pins this on per-model serving rather than request shape.

**The chain, confirmed**

`Detect` asks one probe model per protocol (`detect.go`), `Native` falls back to "every protocol the provider speaks" when `APIs(model)` is nil (`native_endpoints.go`, `provider.go`), a custom relay's `/v1/models` carries no per-model API → nil for all seven models, and the relayed `/v1/messages` 400 (`does not exist`) classifies as `modelRefused` → `unserved` → the model rests on the key. Nothing in that path re-asks translated, which is the one thing that would have worked — your step 3's 200.

**On the four options**

| Option | Reading |
| --- | --- |
| 1 — translate on `modelRefused`, remember in `ModelAPIs` | The reactive shape has house precedent (`formatRefused` marks provider+model and re-asks translated; `thinkingBackNeeded` likewise), and the pref to remember in already exists (`modelprefs.go`). Two limits worth weighing: the retry costs one extra upstream call on every *genuinely* unserved model before it rests; and the matcher only catches what `unservedWords` reads — your own second model (`url error, please check url！`) refuses in words `modelRefused` never sees, so a translate-on-`modelRefused` retry alone would leave exactly that shape hard-failing. Whatever fires the retry has to be broader than the rest's trigger, or the fix covers one of your two failures. |
| 2 — don't generalise a single probe | The fallback default is what makes custom relays work for Anthropic-native clients today (the common case: a relay that does serve Messages). Defaulting to translation would change behavior for every working setup to fix the broken minority — the durable per-model probe (your "Each picked model" flow, persisted) is the safer half of this option. |
| 3 — surface per-model × per-API in `provider test` | Diagnosability only; cheap, no semantics touched. |
| 4 — `magpie model api` CLI | Small, fits the `magpie model name|efforts|…` family, and is the reset path option 1's memory needs (a wrong negative answer must be liftable). |

Options 1+4 compose naturally (learn the negative, lift it by hand); 2 and 3 are independent. One thing I checked that needs no change: the translated retry, if added, reuses the same translated path any Chat client takes — no new protocol machinery.

**Not verified:** no onehub-style relay here — the classification chain (`unservedWords` → `modelRefused` → `unserved`) is read from the code and matches your captured bodies; the 40-request session trace stands as your evidence.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
