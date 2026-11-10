# Sounds

The gallery's sounds are [cuelume](https://github.com/danielwh2/cuelume)'s cues (0.2.8, its default theme),
by Daniel Belyi, under the MIT license in `LICENSE`. cuelume synthesizes them live with Web Audio; these WAVs
are rendered offline by its own renderer (`scripts/sound.mjs`) through `../scripts/sounds.mjs`, which says how.

| File | For |
| --- | --- |
| `tap.wav` | A direct action: a message sent |
| `select.wav` | A choice among options: a segment, a radio, a tab, a demo in the sidebar |
| `toggle.wav` | A state switched: a switch, a checkbox, the theme, sounds on and off |
| `open.wav`, `close.wav` | A sheet opening and closing; a destructive confirm (`close`) |
| `success.wav` | Work finished well: saved, uploaded, copied |
| `warning.wav` | Done, but worth a look |
| `error.wav` | A failure or a refusal |
| `ready.wav` | A result arrived: a reply finished |
| `attention.wav` | A notice that asks for the user |
