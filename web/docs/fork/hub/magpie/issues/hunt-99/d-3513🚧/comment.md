@dazhaozhao The missing 2.5 is deliberate, and on a ChatGPT account there is nothing to switch to. Since v0.1.1217 (`3cd55f65`, #1865) a ChatGPT (Codex) sign-in lists one image model, "GPT Image" (`codex/gpt-image-2`): that backend ignores the `model` field — the probe in #1865 with a real Pro account had `gpt-image-2`, `gpt-image-2.5`, `gpt-image-2.5-sunburst/-flare`, even a made-up name, all return 200 with identical output — so listing 2.5 apart would offer a choice that doesn't exist. Picking "GPT Image" (or leaving it on Automatic, which names the same entry) already draws with whatever ChatGPT's backend serves; a `codex/gpt-image-2.5` saved from an older version keeps drawing and displays as that same entry.

Where a 2.5 name still means something:

- direct API calls: any `gpt-image-*` name is accepted and passed through — this issue's own `"model": "codex/gpt-image-2.5"` on `/v1/images/generations` drew fine;
- an OpenAI API key (not a ChatGPT sign-in) is a different provider: the name is honored there, so `gpt-image-2.5` is listed and selectable where its list has it.

Your screenshot didn't come through — I assumed you meant the Image-generation picker in Settings, which itself notes "ChatGPT's image backend picks the model itself, whichever is named, so one GPT Image is listed". If you meant a different list, a re-upload would tell.

**Attribution**: written with GLM-5.3-Flash (ZCode)
