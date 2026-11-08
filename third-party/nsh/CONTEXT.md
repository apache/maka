# NSH

Native Shell renders one app (TSX or Rust) through each platform's own views. This file names the concepts
introduced for the terminal backend; concepts NSH already has keep the names its code and `AGENTS.md` give them
(`MountItem`, `Surface`, `Development host`, `Release runner`, ...) and are not redefined here.

## Language

### The terminal

**Terminal idiom**:
The device form of a surface shown in a terminal: keyboard first, a pointer when the terminal reports one, drawn
on a grid of cells. A peer of the phone, pad and desktop idioms; the operating system is still reported as the
real one.
_Avoid_: TUI mode, console platform

**Cell**:
One character position of the terminal grid, the unit the terminal backend draws in; a fixed number of points
wide and tall.
_Avoid_: pixel, character, block

**Key scheme**:
The set of keys a terminal surface is operated with when the app binds none of them: moving between what can be
pressed or typed in, scrolling, searching, going back, editing text. The terminal key scheme, after readline and
terminal tools such as fzf and less, is the first; a vim one may follow.
_Avoid_: keymap (the app's own shortcuts), keybindings, mode

**Minibuffer**:
The one-line input a terminal surface shows at its bottom only while the user searches the screen, and removes
when done; the terminal backend has no permanent chrome.
_Avoid_: command line, status line, mode line, echo area

**Terminal look**:
How the terminal backend draws an app: in the look of terminal apps such as grok-build's, not as a copy of the
app's design. The user's terminal theme gives the colors: an app color becomes a meaning (the default
foreground, muted or faint for secondary text, or the accent of a saturated color's hue). Depth is **surfaces**,
steps of the terminal's own background mixed toward its foreground (sunken, raised, hover, select): an app's fill
is a band one step lighter or darker than what it is on (the app's page color is the terminal's background), a
saturated fill its accent tinted in, a filled box has
no line; structure is box-drawing lines in the border step (rounded where the app rounds a corner), and state is
bands and bold: a selected item or focused control a select band, a hovered one a hover band, a disabled one
faint. On a terminal with only 16 colors or an unknown background the look is **bandless**: no fills, dim
secondary text and lines, reversed bands for selection and focus. A control (a button, a tab, a text field,
...) is one row, its label. Shadows, outlines, gradients, opacity, images and icons draw nothing; overlays and
system dialogs are framed boxes over the screen (popovers raised, modals over a faded backdrop). The app decides what is shown and where; NSH adds no look of its own
beyond these conventions, and what the terminal cannot show is left out.
_Avoid_: theme, skin, terminal style, faithful rendering

### Unsupported features

**Unsupported feature**:
A feature the terminal cannot render well; the terminal backend leaves it out rather than imitating it, with no
placeholder, emulation or substitute form. Each one is listed in the backend's documentation.
_Avoid_: fallback, degradation, downgrade, placeholder

**Content feature**:
A feature that carries what the user reads or acts on (images, video, web views, native components without a
terminal rendering); when unsupported it is left out and logged once per kind.
_Avoid_: media

**Decorative feature**:
A feature that only changes how something looks (fills on a terminal without surfaces, shadows, blur, filters, blend modes, gradients,
opacity, transforms other than translation, icons); when unsupported it is left out silently.
_Avoid_: cosmetic, effect
