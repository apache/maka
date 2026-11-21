I took this. The image path for Antigravity clients exists at current main (`7785c4278`) — a draw-model id named on the Code Assist surface takes the draw family and the picture comes back as `inlineData` in the candidates agy reads — so the interesting question is why your model never enters it. Nothing to patch yet; two facts would settle it. Credit @hong65201 for the report.

**The path, so the ask is precise**

- When a request names an image model (or asks to draw), it is routed to the draw machinery and the reply carries the image as `inlineData` (`codeassist.go`: `catalog.DrawsID(sent) || r.draws`). Antigravity's surface reads those parts like any Gemini image model's.
- Whether an id counts as "an image model" is a word match (`DrawsID`/`ImagesAPI` in `catalog.go`): `image`, `imagen`, `dall-e`, `flux`, `seedream`, … So a model id like `gpt-image-1` is recognized by name; a custom entry whose id carries none of the words (an alias, a vendor's own spelling) is **not** — it goes to the provider as a plain chat request, which is one way "configured fine but Antigravity can't draw" happens. #4913 was exactly this shape (Loomy's `Hy-Image` ids missing from the words), fixed by adding the family.

**What would decide it**

1. **The exact model id** as configured in magpie (and whether it's a catalog model or a custom entry of yours). If it carries none of the draw words, that's the gap — a one-word-list addition, and I'll send it.
2. **The request record of one failed attempt from Antigravity** (Usage → Requests; one line is enough). If no line appears at all, agy never asked magpie — its own UI gates image generation to its known image models, which would make this Antigravity-side and outside magpie's reach. If a line appears, its status and error say which half failed (recognition, translation, or the provider).

**Not verified:** no agy installation and no image-capable account here — the path above is read from the code, and both candidate causes (word-list miss, client-side gating) are consistent with "无法正常调用" as described; the report carries no request record or error text to split them.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
