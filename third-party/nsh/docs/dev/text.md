# Text

- **Text**: `<Text numberOfLines ellipsizeMode="tail|head|middle|clip">`; styles `fontFamily` (system or imported fonts:
  `import Inter from "./Inter.ttf"` evaluates to the family name and registers the font before the first frame), `fontWeight`,
  `fontStyle`, `letterSpacing`, `textDecorationLine` + `textDecorationColor`, `textTransform`, `lineHeight`, `textAlign`,
  `textAlignVertical` (the core moves the content box down). `adjustsFontSizeToFit` shrinks the fonts (down to
  `minimumFontScale`, at least 0.1) until the text fits its box and lines (`Paragraph::fit`, a binary search in the core).
  `onTextLayout` reports the final lines (`TextEngine::lines`: range, box, ascender, descender, cap / x height).
  Final layouts are hit-tested by their engine too, in the content box (`TextEngine::hit_test`,
  `caret_rect`, `range_rects`): the caret position nearest a point (`TextPosition`: a UTF-16 offset and its
  `Affinity`, which says whether an offset that ends a wrapped line and starts the next is on the earlier line), the
  caret's line-high box, and the line-high boxes a range covers, appended to the caller's buffer. Each backend's
  selection and `SelectionArea` hit-test with the same code; an engine that only reports `lines` gets an estimate
  (each line's characters spread evenly over its width). The headless engine hit-tests whole characters, 0.55 em
  each, on its one line. CoreText retains original offsets for the visible suffix of head / middle
  truncations and omits the ellipsis from range boxes; mixed-direction ranges split by visual run on both Apple
  backends. Web hit testing measures cluster rectangles in the complete drawn DOM run on first use, keeps both
  edges at bidi boundaries and caches them with the layout. Linux selection drawing reuses its rectangle buffer.
  Test-id-only span updates remount the text metadata with its cached final layout (`LaidText`), retaining fitted
  font sizes. They preserve prepared state and measurement caches and raise no `onTextLayout`.
  A text out of the layout (`display: none` on it or on a view around it, `hidden`) is sent with an empty layout (its
  text unchanged, for tests and screen readers): its box is zero, and the web, which does not clip text to its box,
  would still draw the glyphs laid out in it.
  `selectable` (or `select-text`): range selection, drawing only (`AttributedText::selectable` /
  `selection_color`, not part of layout). iOS (`text_selection.rs`): the CoreText `TextView` adopts `UITextInput`
  (non-editable: no keyboard, `inputView` is empty) and a `UITextInteraction` (`NonEditable`) attached only while the text
  is selectable gives UIKit's long press, loupe, handles, highlight (the view's tint, which `selectionColor` sets) and edit
  menu (Copy, Select All, and the system's Look Up / Translate / Share); positions are UTF-16 offsets on the CTLines.
  Resigning first responder (a tap elsewhere, another input focusing) ends the selection. Android (`TextBox`): a long press
  selects the word (`BreakIterator`) and the rest of the gesture extends it; handles are the theme's
  `textSelectHandleLeft/Right` in popup windows (so they escape clipping and take their own touches), the highlight is
  `Layout.getSelectionPath` in `selectionColor` (55% alpha; the theme's `textColorHighlight` by default) and a floating
  action mode offers Copy, Select all and Share. A touch elsewhere in the surface (`Mounter.touchDown`), new text or
  detaching ends it; one selection at a time per surface. Copy leaves attachments' placeholders out on both. Text that is
  not selectable has no interaction, listener or extra drawing. `selectable` is `Option<bool>` (unset, or `false` from
  `selectable={false}` / `select-none`) because the web's desktop idiom selects text that is not set off by default, as a
  web page does, except inside views that take presses or touches. Web: the browser's own selection, `::selection` in
  `selectionColor`; copying joins the absolutely placed runs with each line's break ([web.md](web.md)). Linux (`text.rs`, desktop conventions): a mouse drag selects characters (past a 3 pt slop, 10 pt over a
  press target, so clicking a link still presses it), a double click words, a triple click the paragraph (drags go on by
  them), Shift+click extends; the highlight is drawn behind the glyphs in `selectionColor` at 30% (the system blue by
  default); the view takes keyboard focus only while it has a selection, for Ctrl+C (and Ctrl+Insert), Ctrl+A and
  Escape, and a press anywhere else or losing focus ends it; a finished drag also sets the primary selection.
  Touchscreen drags scroll instead; there is no context menu. GPUI (`nsh-platform-gpui` `text.rs`): the same selection
  (Cmd instead of Ctrl on macOS), plus a right-click menu (Copy, Select All: `chrome::popup_actions`). Its engine
  shapes each paragraph once with GPUI's text system, in segments of one bidi level and font size, and does the rest
  itself: lines break at UAX #14 opportunities (`unicode-linebreak`), measuring at another width only re-breaks, and
  each line's clusters are ordered by their bidi levels (`unicode-bidi`); a blurred text shadow is the glyphs painted
  faintly around the blur radius (GPUI blurs no glyphs). GPUI loads variable fonts at their default weight only, so on
  Linux the UI font is the first of a list that GPUI can set in bold (GNOME's Adwaita Sans is variable: Noto Sans or
  DejaVu Sans take its place, with Adwaita Sans's ascent and descent, so lines are as tall as GTK's). Symbols that are
  text by default (♥, ✓) take a text font when the fallback would draw them as color emoji, so the text's color applies.
- **Selection areas**: a view with `ViewProps::selection_area` (`SelectionArea` of `nsh/base`, a selectable
  `TextView`; set by components with `Element::selection_area`, the internal host prop `Prop::SelectionArea`) makes
  its texts select together, as a browser page's do: one selection from a place in one text to a place in another, in
  document order (the area's subtree, depth first), across paragraphs, views and `TextView`s. The model is
  platform-independent (`nsh_core::selection`): a backend lists the area's texts (`SelectionTexts`: content, content
  boxes in the area's coordinates with scroll offsets applied, its text engine's hit test), feeds `SelectionModel` its
  gestures (press with the click count and Shift, drag, long press, a handle's drag, select all) and draws what
  `ranges` says with its own highlight (each text's `selectionColor`), handles and menu; Copy takes `text` (attachments
  left out, texts on one row joined by a tab, the others by a line break). Positions are (text index, UTF-16 offset),
  never inside a surrogate pair. A point outside every text is hit-tested in reading order: the horizontally nearest
  text on its row, above every text the first text's start, below every text the last one's end, between rows the
  nearer of the end of the text above and the start of the text below. Words are runs of letters, digits and `_`, runs
  of spaces, or single other characters (each CJK ideograph, kana, emoji or punctuation mark); a triple click selects
  a whole text. Desktops select as their single texts do (drag, double click words, triple click paragraphs, drags go
  on by them, Shift+click extends; Ctrl / Cmd+A, Ctrl / Cmd+C, Escape; a press elsewhere clears), touch screens with a
  long press (a word) and then the platform's handles and edit menu (Copy, Select All). Texts with `selectable={false}`
  stay out; an area inside another is part of the outer one (only the outermost area keeps a model); texts outside
  areas select alone, as above. Views without the flag change nothing (no extra mount items). iOS
  (`selection_area.rs`): `UITextInteraction` selects within one `UITextInput` view, so an area has its own
  `AreaResponder`, a zero-sized subview at the area's origin (its coordinates are the area's) that owns the model and
  is the first responder its Copy and Select All (and the hardware keyboard's ⌘C / ⌘A) go to. On the area: a long
  press (fingers, the Pencil) selects a word and its drag goes on by words; two handles (a stem and a round knob in
  the tint, subviews of the area kept in front, with enlarged touch targets; scroll views wait for their drag to
  fail) move the ends and hide where a clipping scroll view cuts their caret off; a tap off the highlight clears, on
  it toggles the edit menu (`UIEditMenuInteraction` from iOS 16, `UIMenuController` before: Copy, Select All).
  Pointers (Mac Catalyst's mouse, iPad trackpads) select as on the desktops, without handles. The texts are the
  area's `TextView`s (key: their node), listed again when a gesture starts and, while something is selected, after
  every batch and scroll; each draws its part of the highlight behind its glyphs (`selectionColor`, else the tint, at
  20%), and texts in an area drop their own `UITextInteraction` (`TextView::in_selection_area`). Resigning first
  responder clears, so a surface shows one selection. Android (`selection_area.rs`, `SelectionArea.java`): the
  shared Rust model runs on the UI thread over JNI, hit-testing through a Java callback; a long press selects a word,
  then handles and a floating `ActionMode` (Copy, Select all, Share).
- **Span backgrounds**: `backgroundColor` / `borderRadius` on a nested `<Text>` (its view style, which spans otherwise
  ignore) become `ResolvedTextStyle::background` (`TextBackground`: color, radius and the span's node, so neighboring
  spans that look the same stay apart), inherited by the spans inside it; the block's own background stays its view's.
  Drawing only (not in `layout_eq`). Each backend lists a line's pieces in visual order (clusters, glyphs or runs, with
  their font's ascent and descent) and `BackgroundBox::join` joins the neighbors of one background into a box per
  line, cut to the line's ink (hanging whitespace is not painted); the box is the font's ascent to descent (CSS's
  inline box), rounded on every line (`box-decoration-break: clone`), drawn behind the selection and the glyphs. CoreText
  splits runs where the background's `NshBackground` attribute changes; the web emits the boxes as elements behind
  the runs.
- **Inline attachments**: any other element inside a `<Text>` (also inside its spans) is an attachment: laid out as its own
  layout root at its content size (`update_attachments`), it becomes an object replacement character (U+FFFC,
  `AttributedText::attachments`) that the engine sizes to it (CTRunDelegate; Android a `ReplacementSpan`), so
  it wraps with the text. Its style key `verticalAlign` (`VerticalAlign`, CSS `vertical-align` of a replaced inline
  box, `align-*` classes; a node field like `zIndex`, a change rebuilds the block) places it in its line:
  `AttachmentAlignments` keeps alignment separately from the legacy `TextAttachment` and
  `AttributedText` structs. The core stores it in its private text context and includes it in measurement-cache
  keys; `TextEngine::prepare_aligned` accepts it, with a default that calls `prepare` for existing engines.
  `TextAttachment::ascent(font, align)` is how far its top is above the baseline (`baseline` the height, the default and the only
  value before; `text-top` the font's ascent, `text-bottom` the height minus the descent, `middle` half the height
  plus the x height), `extent` what the line reserves above and below (each at least 0), both from the
  `FontExtent` of the placeholder's font, the only platform part. Every engine gives the placeholder that extent
  (CoreText's delegate ascent / descent; Android's `Attachment` span fills `FontMetricsInt`, the same rule ported to
  Java with `Paint.getFontMetrics` and the bounds of `x`; Pango a shape whose logical rectangle is the extent and ink
  the box; DirectWrite and GPUI their line boxes; the web its line box, taking the extents only when an attachment
  reaches below the baseline so baseline-only lines keep their height) and places its top `ascent` above the
  baseline, so a line grows where an attachment reaches past the font, as Android's `ImageSpan` grows it. CSS's
  `top` / `bottom` (the line box's) and `sub` / `super` / lengths are not offered: the engines size placeholders
  before lines exist. The headless engine's font is its line (ascent 1.2 em, descent 0, x height 0.5 em). After the final layout the core places its native view, a child of the text view (Android's
  `TextBox` is a ViewGroup for this), on the placeholder (`TextEngine::attachments`); attachments cut off by the line limit or
  an ellipsis move out of sight. Their own children are normal layout children; a text inside them built after the block
  resizes them and builds the block again (`check_attachments`). They take presses of their own; copying leaves the
  placeholders out.

- **Rust components** nest texts the same way: `text("a ").child(text("b").underline().on_press(..)).child(view())` is
  one block; a plain string child is a raw text node (as JS's strings), a text's own content its first piece
  (`core/components.rs`, `Part::Raw`).

See also the text pitfalls in [pitfalls.md](pitfalls.md) and the engines in `crates/nsh-platform-ios/src/text.rs` /
`crates/nsh-platform-android/src/text.rs`.
