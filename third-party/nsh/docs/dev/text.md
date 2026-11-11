# Text

- **Text**: `<Text>`; styles `numberOfLines`, `textOverflow` (`ellipsis|clip|ellipsis-start|ellipsis-middle`: `EllipsizeMode`'s
  `Tail|Clip|Head|Middle`), `fontFamily` (system or imported fonts:
  `import Inter from "./Inter.ttf"` evaluates to the family name and registers the font before the first frame; a host can register the same files itself, `NshView.registerFont` / `NshAppView.registerFont`, and the app names the family), `fontWeight`,
  `fontStyle` (italic runs leave color emoji upright, in runs of their own: `AttributedText::push`, as WebKit does;
  Chrome and Android would slant them), `letterSpacing`, `textDecorationLine` + `textDecorationColor`, `textTransform`, `lineHeight`, `textAlign`,
  `textAlignVertical` (the core moves the content box down). `adjustsFontSizeToFit` shrinks the fonts (down to
  `minimumFontScale`, at least 0.1) until the text fits its box and lines (`Paragraph::fit`, a binary search in the core).
  On iOS and macOS, a positive fixed-height box keeps its first line even when that line is taller than the box
  (Dynamic Type on iOS; on both, a box a fraction of a point shorter than the line's measured height).
  CoreText positions it from the same top edge as an unconstrained line; the view's drawing bounds clip the
  excess. Empty and zero-height boxes stay empty.
  `onTextLayout` reports the final lines (`TextEngine::lines`: range, box, ascender, descender, cap / x height).
  Final layouts are hit-tested by their engine too, in the content box (`TextEngine::hit_test`,
  `caret_rect`, `range_rects`): the caret position nearest a point (`TextPosition`: a UTF-16 offset and its
  `Affinity`, which says whether an offset that ends a wrapped line and starts the next is on the earlier line), the
  caret's line-high box, and the line-high boxes a range covers, appended to the caller's buffer. Each backend's
  selection and selectable views hit-test with the same code; an engine that only reports `lines` gets an estimate
  (each line's characters spread evenly over its width). The headless engine hit-tests whole characters, 0.55 em
  each, on its one line. CoreText retains original offsets for the visible suffix of head / middle
  truncations and omits the ellipsis from range boxes; mixed-direction ranges split by visual run on both Apple
  backends. Web hit testing measures cluster rectangles in the complete drawn DOM run on first use, keeps both
  edges at bidi boundaries and caches them with the layout. Linux selection drawing reuses its rectangle buffer.
  Test-id-only span updates remount the text metadata with its cached final layout (`LaidText`), retaining fitted
  font sizes. They preserve prepared state and measurement caches and raise no `onTextLayout`.
- A text engine whose lines take all that fits and whose `measure` reports the widest line's width says so
  (`TextEngine::breaks_lines_greedily`: macOS, Linux). The core then reuses a measurement for every maximum width from
  that width to the one measured (`measure_text`, `SameLines`), and measures a growing width a little ahead to cover
  the next ones, until a text's lines change within that margin. Limits on lines are measured at every width. A
  window's resize changes the width of every text of a page on every size.
  Another width with the same lines also keeps the final layout when every line starts at the box's left
  (`flush_text`, `keeps_lines`), so the platform has nothing to typeset and macOS nothing to draw.
  During a burst of resizes (`Core::set_resizing`, the engine's `RESIZE_BURST_GAP`), text more than a screen away from
  the screen (`Core::mark_near_screen`, from the last commit's frames) is neither measured nor laid out at new widths:
  it keeps its height, and catches up as it comes near or in the commit after the burst ends. Content below the
  viewport's height therefore settles when the drag ends; a page scrolled past text that grows keeps what it shows
  (`core/resize_anchor.rs`).
  A text out of the layout (`display: none` on it or on a view around it, `hidden`) is sent with an empty layout (its
  text unchanged, for tests and screen readers): its box is zero, and the web, which does not clip text to its box,
  would still draw the glyphs laid out in it.
  `userSelect: "text"` (or `select-text`): range selection, drawing only (`AttributedText::selectable` /
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
  `userSelect: "none"` / `select-none`; a view's `userSelect` reaches the texts in it that set none) because the
  web's desktop idiom selects text that is not set off by default, as a web page does, except inside views that take presses or touches. Web: the browser's own selection, `::selection` in
  `selectionColor`; copying joins the absolutely placed runs with each line's break ([web.md](web.md)). Linux (`text.rs`, desktop conventions): a mouse drag selects characters (past a 3 pt slop, 10 pt over a
  press target, so clicking a link still presses it), a double click words, a triple click the paragraph (drags go on by
  them), Shift+click extends; the highlight is drawn behind the glyphs in `selectionColor` at 30% (the system blue by
  default); the view takes keyboard focus only while it has a selection, for Ctrl+C (and Ctrl+Insert), Ctrl+A and
  Escape, and a press anywhere else or losing focus ends it; a finished drag also sets the primary selection.
  Touchscreen drags scroll instead; there is no context menu. GPUI (`nsh-platform-gpui` `text.rs`): the same selection
  (Cmd instead of Ctrl on macOS), plus a right-click menu (Copy, Select All: `chrome::popup_actions`). Its text engine is
  built on GPUI's text system (`nsh-platform-gpui` `text.rs`). GPUI loads variable fonts at their default weight only, so on
  Linux the UI font is the first of a list that GPUI can set in bold (GNOME's Adwaita Sans is variable: Noto Sans or
  DejaVu Sans take its place, with Adwaita Sans's ascent and descent, so lines are as tall as GTK's). Symbols that are
  text by default (♥, ✓) take a text font when the fallback would draw them as color emoji, so the text's color applies.
- **Selectable views**: a view with `ViewProps::selectable_view` (`<View selectable>` of `nsh`, a selectable
  `TextView`; set by components with `Element::selectable`, the internal host prop `Prop::SelectableView`) makes
  its texts select together, as a browser page's do: one selection from a place in one text to a place in another, in
  document order (the area's subtree, depth first), across paragraphs, views and `TextView`s. The model is
  platform-independent (`nsh_core::selection`): a backend lists the area's texts (`SelectionTexts`: content, content
  boxes in the area's coordinates with scroll offsets applied, its text engine's hit test), feeds `SelectionModel` its
  gestures (press with the click count and Shift, drag, long press, a handle's drag, select all) and draws what
  `ranges` says with its own highlight (each text's `selectionColor`), handles and menu; Copy takes `text` (attachments
  left out, texts on one row joined by a tab, the others by a line break, a text that continues the one before it by
  nothing). A component that lays one line out as several texts (a code view's soft-wrapped line: `DiffView`) marks
  the later parts with `Element::continues_text` (`ViewProps::continues_text`, the internal `Prop::ContinuesText`;
  `SelectionTexts::continues` reads it): a copy gives the line whole, a triple click selects the whole line, and a
  double click takes a word the wrap cut across its parts. Every backend reads it from its text views' props (Android
  passes it to the model with the texts, `nativeSetTexts`); the web's copy joins such texts by nothing (the browser's
  own selection takes the clicks). Positions are (text index, UTF-16 offset),
  never inside a surrogate pair. A point outside every text is hit-tested in reading order: the horizontally nearest
  text on its row, above every text the first text's start, below every text the last one's end, between rows the
  nearer of the end of the text above and the start of the text below. Words are runs of letters, digits and `_`, runs
  of spaces, or single other characters (each CJK ideograph, kana, emoji or punctuation mark); a triple click selects
  a whole text. Desktops select as their single texts do (drag, double click words, triple click paragraphs, drags go
  on by them, Shift+click extends; Ctrl / Cmd+A, Ctrl / Cmd+C, Escape; a press elsewhere clears), touch screens with a
  long press (a word) and then the platform's handles and edit menu (Copy, Select All). Texts with `userSelect: "none"`
  stay out; an area inside another is part of the outer one (only the outermost area keeps a model); texts outside
  areas select alone, as above. Views without the flag change nothing (no extra mount items). iOS
  (`selectable_view.rs`): `UITextInteraction` selects within one `UITextInput` view, so an area has its own
  `AreaResponder`, a zero-sized subview at the area's origin (its coordinates are the area's) that owns the model and
  is the first responder its Copy and Select All (and the hardware keyboard's ⌘C / ⌘A) go to. On the area: a long
  press (fingers, the Pencil) selects a word and its drag goes on by words; two handles (a stem and a round knob in
  the tint, subviews of the area kept in front, with enlarged touch targets; scroll views wait for their drag to
  fail) move the ends and hide where a clipping scroll view cuts their caret off; a tap off the highlight clears, on
  it toggles the edit menu (`UIEditMenuInteraction` from iOS 16, `UIMenuController` before: Copy, Select All).
  Pointers (Mac Catalyst's mouse, iPad trackpads) select as on the desktops, without handles. The texts are the
  area's `TextView`s (key: their node), listed again when a gesture starts and, while something is selected, after
  every batch and scroll; each draws its part of the highlight behind its glyphs (`selectionColor`, else the tint, at
  20%), and texts in an area drop their own `UITextInteraction` (`TextView::in_selectable_view`). Resigning first
  responder clears, so a surface shows one selection. Android (`selectable_view.rs`, `SelectableView.java`): the
  shared Rust model runs on the UI thread over JNI, hit-testing through a Java callback; a long press selects a word,
  then handles and a floating `ActionMode` (Copy, Select all, Share).
- **Color changes**: a text whose spans change only their colors (text, decoration and background) or which of them
  are hidden keeps its typesetting, measurements and layout where the platform draws colors from the text it mounts
  (`TextEngine::draws_colors_from_text`: macOS, Windows, Linux and GPUI, which also read `hidden` there): only the new
  text is mounted with the layout, so a word fading in, or shown after waiting hidden, costs one draw, not a new layout
  of its paragraph. The other backends typeset it again.
- **Span backgrounds**: `backgroundColor` / `borderRadius` on a nested `<Text>` (its view style, which spans otherwise
  ignore) become `ResolvedTextStyle::background` (`TextBackground`: color, radius and the span's node, so neighboring
  spans that look the same stay apart), inherited by the spans inside it; the block's own background stays its view's.
  Drawing only (not in `layout_eq`). Each backend lists a line's pieces in visual order (clusters, glyphs or runs, with
  their font's ascent and descent) and `BackgroundBox::join` joins the neighbors of one background into a box per
  line, cut to the line's ink (hanging whitespace is not painted); the box is the font's ascent to descent (CSS's
  inline box), rounded on every line (`box-decoration-break: clone`), drawn behind the selection and the glyphs. CoreText
  splits runs where the background's `NshBackground` attribute changes; the web emits the boxes as elements behind
  the runs.
- **Hidden spans**: `visibility: "hidden"` on a nested `<Text>` (`.invisible()`) marks its runs, and those of the
  spans inside it, `ResolvedTextStyle::hidden`. The core resolves them in `collect_text`: their characters stay in the
  text and lay out as visible ones (`hidden` is not part of `layout_eq`, so toggling it draws again without measuring,
  and where colors are drawn from the text without typesetting either), and they make no links; attachments inside them are hidden views (`Core::hide_attachments`). Each backend skips the
  hidden runs when it draws (glyphs, color emoji, decorations, shadows, animated colors), never relying on the
  transparent color alone; macOS, Windows, Linux and GPUI also leave them out of selection highlights
  (`AttributedText::visible_ranges`), while iOS and Android highlight a selection over them. What leaves
  the text through the user goes through `AttributedText::copied_text` (copies: hidden runs and attachments'
  placeholders left out) and `visible_text` (screen readers, the test model's texts); selectable views copy through
  `SelectionTexts::copied`. Android marks the runs with a span of their own in the laid out text, which its drawing,
  copies and TalkBack read; the web gives the runs `visibility: hidden`.
- **Inline attachments**: any other element inside a `<Text>` (also inside its spans) is an attachment: laid out as its own
  layout root at its content size (`update_attachments`), it becomes an object replacement character (U+FFFC,
  `AttributedText::attachments`) that the engine sizes to it (CTRunDelegate; Android a `ReplacementSpan`), so
  it wraps with the text. Its style key `verticalAlign` (`VerticalAlign`, CSS `vertical-align` of a replaced inline
  box, `align-*` classes; a node field like `zIndex`, a change rebuilds the block) places it in its line:
  `AttachmentAlignments` keeps alignment separately from the legacy `TextAttachment` and
  `AttributedText` structs; `TextEngine::prepare_aligned` accepts it, with a default that calls `prepare` for existing
  engines.
  `TextAttachment::ascent(font, align)` is how far its top is above the baseline (`baseline` the height, the default and the only
  value before; `text-top` the font's ascent, `text-bottom` the height minus the descent, `middle` half the height
  plus the x height), `extent` what the line reserves above and below (each at least 0), both from the
  `FontExtent` of the placeholder's font, the only platform part. Every engine gives the placeholder that extent
  (CoreText's delegate ascent / descent; Android's `Attachment` span fills `FontMetricsInt`, the same rule ported to
  Java with `Paint.getFontMetrics` and the bounds of `x`; Pango a shape whose logical rectangle is the extent and ink
  the box; DirectWrite and GPUI their line boxes; the web its line box, taking the extents only when an attachment
  reaches below the baseline so baseline-only lines keep their height) and places its top `ascent` above the
  baseline, so a line grows where an attachment reaches past the font, as Android's `ImageSpan` grows it. With a fixed
  `lineHeight` a line holding an attachment is at least as tall as its text's lines (the font with the line height
  spread around it, CSS's strut) and grows only where the attachment reaches past that box, on every engine: the
  line height is never a cap that cuts an attachment to the line. CSS's
  `top` / `bottom` (the line box's) and `sub` / `super` / lengths are not offered: the engines size placeholders
  before lines exist. The headless engine's font is its line (ascent 1.2 em, descent 0, x height 0.5 em). After the final layout the core places its native view, a child of the text view (Android's
  `TextBox` is a ViewGroup for this), on the placeholder (`TextEngine::attachments`); attachments cut off by the line limit or
  an ellipsis move out of sight. Their own children are normal layout children; a text inside them built after the block
  resizes them and builds the block again (`check_attachments`). They take presses of their own; copying leaves the
  placeholders out. Text inside an attachment takes the color of the text around it (the nearest color set on its
  spans, its block or the views around, as CSS's `color` reaches an inline block and `currentColor` reaches the
  attachment's view), unless it sets its own; the rest of its text style (font, size, line height) is not passed in,
  so the attachment's box is sized by its own content (`Core::inherited_text_style`). A color change on the text
  rebuilds the texts inside its attachments.

- **Rust components** nest texts the same way: `text("a ").child(text("b").underline().on_press(..)).child(view())` is
  one block; a plain string child is a raw text node (as JS's strings), a text's own content its first piece
  (`core/components.rs`, `Part::Raw`).

See also the text pitfalls in [pitfalls.md](pitfalls.md) and the engines in `crates/nsh-platform-ios/src/text.rs` /
`crates/nsh-platform-android/src/text.rs`.
