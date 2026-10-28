# Scrolling and lists

- **Scrolling**: `pagingEnabled`, `snapToInterval` / `snapToOffsets` / `snapToAlignment`, `disableIntervalMomentum`,
  `decelerationRate`, `scrollable`, `bounces`, `contentInset`, `contentOffset`, `keyboardShouldPersistTaps`
  (`never` / `handled` / `always`), `onScroll` (+ `scrollEventThrottle`; at most once per engine turn), `onScrollDragStart` /
  `EndDrag`, `onMomentumStart` / `End` (a glide caught by a new drag ends with `onMomentumEnd`). Snapping is decided
  by `ScrollBehavior::snap_target` (core) on iOS and its Java port on Android, from the release offset, the projected glide and
  the velocity. Lists keep the visible rows in place when items are inserted above them (`splice`).
- **Input**: fingers (and pens) drag scroll views; on the desktop backends and the web the mouse never does (dragging
  the content is a touchscreen's way to scroll): it scrolls with the wheel, the touchpad, the keyboard and the
  indicator (a scroll bar), and its drags are the app's (pans, responders, text selection). On Linux, Windows and desktop Web, the indicator shows while scrolling or when the pointer reaches its draggable thumb;
  moving over content leaves its visibility and fade timer unchanged. macOS follows the system's scroll-bar
  visibility preference (`WhenScrolling` suppresses content-hover reveal). Horizontal
  views keep theirs with `scrollbar={false}` (the platforms' `scroll::config`; on the web `barShown`, in the
  desktop idiom): a mouse without a horizontal wheel has no other way to move them. With a
  mouse alone, pull to refresh needs a touchpad that rubber-bands (macOS): apps offer another way on the desktop.
- **Scroll bars of the app's own** (`nsh/base`'s `Scrollbar`, `docs/dev/components.md` "Scroll bars"): a view the
  app places that names a scroll view or a list (`scroll={ref}`), with its look (`class`, `thumbClass`) and `mode`;
  the target's own indicator off with `scrollbar={false}`. It follows the target through the core
  (`element::watch_scroll`: the offset every platform reports, the content size the layout sends), so it
  works on every backend, and scrolls it with `ScrollTo`. With an app theme (`Scrollbar.setTheme`) or a view's own
  (`scrollbar={{ … }}`) the core draws one over every such view in place of its indicator (`ScrollConfig.replaced`,
  which also hides the horizontal views' kept indicator on the desktops); `docs/dev/components.md` "Scroll bars".
- **Content container** (`<Scroll>`): `contentStyle` / `contentClass` are the renderer's
  (`dom.rs` `scroll_content`): the first one set makes a view the scroll view's children move into (also the ones
  already there; later inserts and removals go to it), and styles it. The core lays a scroll view's children out in
  the scroll view itself, so without it nothing changes (no extra view).
- **Changing extents** (GPUI, Linux and Windows): changing the scrolling axis ends motion on the old axis and
  preserves offsets that remain within the content. Changes to content, viewport size or content insets reconcile
  offsets after the mount batch, so an anchoring `ScrollBy` in that batch applies first. Layout animations notify
  the same range check as their viewport changes. Animated scrolls finish within the current extent.
- **Zooming** (`<Scroll>`, not lists): `maximumZoomScale` above `minimumZoomScale` makes the content zoomable; `zoomScale`
  zooms when it changes, `bouncesZoom`, `zoomable`, `centerContent` (content smaller than the viewport is centered);
  ref `zoomTo({ scale, x, y, animated })` (content point `x`, `y` in the middle); `onScroll` reports `zoomScale` and the zoomed
  content size. iOS: the children live in a `NshZoomView` (`zoom.rs`) that UIKit scales (`viewForZoomingInScrollView:`), its
  bounds the unzoomed content size, so the core's frames stay valid; texts and canvases are drawn again at the zoomed
  resolution when a zoom ends. Android has no zooming scroll view: `ScrollBox` switches to its `ZScroll`, which scales the
  content around its top left and scrolls both ways itself (ScaleGestureDetector around the focal point, panning with any
  number of fingers, OverScroller flings, rubber bands past the edges and the zoom limits). Pinches start only after
  Android's minimum span (about 27 mm between the fingers). Zoom reports go to the core (`EngineControl::zoom`).
- **List** props: `each`, `estimatedItemSize`, `numColumns`, `inverted` (chat: item 0 at the bottom, starts at the end and keeps its
  distance from the end as content changes; with `onLoadMoreAtStart`, only while at it, the visible rows when scrolled away), `maintainVisibleContentPosition` (`autoscrollToBottomThreshold`: a list
  that is not inverted follows its end while within that distance of it, `ListState::anchor_end`; scrolled up, growth
  below the viewport moves nothing; Rust components: `ListLayout::follow_end`, on their own lists and the lists they place), `stickyHeaderIndices` (one column, not inverted) + `stickyHeaderOffset` (where they stick: the core subtracts a number from the sticky ranges, so platforms pin as they do without one; an animated node rides along in `StickyCell::offset`, `ListState::sticky_node`, and the platforms add its value as they pin), `header` /
  `footer` / `empty` / `separator` (a component or an element; functions and their returned children stay reactive
  as in ordinary JSX children), `contentStyle`
  (padding and gaps, numbers) / `contentClass` (`p-*`, `gap-*`), `initialScrollIndex`, `onLoadMore` + `loadMoreThreshold`,
  `onLoadMoreAtStart` + `loadMoreAtStartThreshold` (below), `onViewableItemsChange` +
  `viewabilityConfig` (`itemVisibleThreshold` / `viewAreaCoverageThreshold` / `minimumViewTime`), `keyExtractor`,
  `refreshing` / `onRefresh`, `refreshIndicator`, `pullValue`, `scrollValue`. Every other prop (`testID`, accessibility, `class`, `onLayout`, touch
  props, ...) goes to the scroll view as on a `<Scroll>` (`list.rs` `OWN`: the names are read once, when the list is
  made; their values follow their getters). Positions, columns, sticky travel and viewability are all computed in the core; sticky cells
  are pinned natively on every scroll (`MountItem::StickyCells`: translate by `clamp(offset + value - start, 0, end - start)`, `value` the cell's animated offset or 0);
  cells with an animated offset are pinned again on the animation graph's frames too (the desktops' `Animator::sticky_views`,
  iOS's `apply_animations`, Android's output code 15, the web's `sticky-offset` output), so they follow a moving bar
  while the content stands still;
  the web, whose scroll events trail the browser's scrolling by a frame, puts each in a track spanning that travel
  instead and lets the browser's `position: sticky` keep it pinned (`nsh.js` `op_sticky`).
- **Loading at either end** (`ListState::update_window`, which returns the `Edges` to raise; both raised by the core):
  `onLoadMore` fires once per item count when the viewport comes within `loadMoreThreshold` viewports of the end (also
  where the list opens: a first page shorter than that asks for the next). `onLoadMoreAtStart` is its counterpart at
  the start (item 0's side: the top, the bottom of an inverted list), for a list opened at an old item that loads
  what comes before it (a chat's newer messages). It fires when the viewport comes within
  `loadMoreAtStartThreshold` viewports of the start, once per approach: again only after the viewport left that
  zone, or when the count changed while it stayed there (a page that did not fill the zone). Never where the list
  opens: only once the user scrolled it (an offset report that is not a pending scroll's, beyond a point of
  rounding) or a scroll command moved it (`initialScrollIndex`, `scrollToIndex`, ...; `ListState::pin`), so a list
  opening at its newest item asks for nothing, and one opening at item 2 with `initialScrollIndex` does. The page
  the app prepends keeps the visible rows in place (`splice`), so the list leaves the zone and the next approach
  fires again. The `onLoadMoreAtStart` listener also opts an inverted list
  into what that needs (rule 4 of `compatibility.md`: inverted lists without it behave as before): it keeps its
  distance from the end (the bottom) only while it is at its start, where item 0 shows (a chat's new message);
  scrolled away from it, a splice or a measurement before the viewport keeps the visible rows in place as on other
  lists (`ListState::loads_at_start`, `keeps_visible_rows`; `measured` returns what cancels `anchor_end`'s scroll).
- **Spare list cells** (recycled cells without an item) keep their last row. The core hides them (`Core::set_spare`:
  `visibility: hidden` and `accessibilityElementsHidden`) when they lie in the render window, were never placed or
  the items changed, and shows them as it places them; the few the window leaves behind while scrolling stay shown.
- **List scroll commands**: the core resolves a list's `scrollToEnd` / `scrollToIndex` to a `ScrollTo` with the sizes it
  knows, which are estimates for rows never rendered; the target stays pinned (`ListState::follow_pin`), and as the rows
  around it are measured the list follows it (a `ScrollBy`, or a retargeted `ScrollTo` while an animated scroll is in
  flight) until the rows in the viewport are all measured, the user scrolls away or the items change. Platforms only
  apply what they get. `scrollToIndex({ automatic: true })` on GPUI and terminal backends waits for the list's
  native hover/focus-within snapshot, retains only the latest target while the list is being operated, and resumes
  without another app request when interaction ends. It uses the same target pin, not the issued-scroll ACK ledger.
  Other native backends do not yet report the direct focus-within snapshot this opt-in behavior requires. Ordinary
  explicit commands are unchanged. For immediate automatic recentering use `animated: false`.
- **Lists in their parent's viewport** (`viewport="parent"`, `ListLayout::viewport(ListViewport::Parent)`; `own`,
  the default, is a scroll view of its own): fixed when the list's native view is made (a change in the batch that
  makes it counts; later ones warn once). The list mounts as a plain view clipping its cells, its Taffy node gets a
  layout-only child (the spacer) `content_len` long, so it lies in its parent's layout at its full length (padding,
  border and size limits as in a browser) and the scroll view around it covers it; a change of length lays the page
  out again in the same commit (`Core::commit`'s rounds). Its view is the nearest scroll view or own list around it
  on its axis, else the root view it is in (screen, modal, overlay, ...), found again when views move in a tree with
  such lists; the scroll view keeps its lists (`ScrollState::dependents`) and marks them for an update when it
  scrolls. The list's `ListState` gets the view's offset less where the list starts in its content (frames summed up
  to the view, plus the list's border and padding; negative while the list is below the viewport's start) and the
  view's viewport, so the window, `onLoadMore`, viewability and pins run unchanged in list coordinates; lists in
  the cells of other lists update after them. Anchoring is a browser's: the view moves only for rows measured or
  spliced wholly above its viewport's top while the list's start is scrolled past; `scrollToIndex`,
  `scrollToEnd` and `initialScrollIndex` scroll the view, clamped to its content. Those scrolls are summed per view
  and sent at the end of the commit (one `ScrollBy`, growing content first, shrinking after), counted with the
  view's own (`ScrollState::issued`; platforms count every `ScrollBy` and `ScrollTo` from the view's creation) and
  replayed over stale reports, as a list does its own; scroll commands for a list not placed in its view yet wait
  for the update that places it. The scroll view's props (`onScroll` and the other scroll events, `scrollValue`,
  `refreshing`, `refreshIndicator`, `pullValue`, paging and snapping, `contentInset`, `scrollbar`, `scrollable`, `keyboardDismissMode`) and what
  needs a scroll view of the list's own (`inverted`, `maintainVisibleContentPosition`) are ignored there, each
  warned of once; a zoomable scroll view around it is not supported. Sticky rows stick to the view's viewport:
  their ranges are in the view's offsets, the last one stopping where its bottom meets the end of the list's
  content (CSS `position: sticky` in its container), and the view gets one `StickyCells` with all its lists' (and
  its own, when it is a list). The cells are not the view's children, so the core keeps them on top among their
  list's cells itself (it moves a cell that became sticky last with an `Insert`, and puts new cells below them);
  the platforms find them by id (the desktops' `with_cell` also looks below the view's children while a batch is
  applied), and the web hosts a cell's track in its list, offset by where the list is in the view's content
  (`trackOrigin`; views clip with `overflow: clip`, which lets `position: sticky` reach the scroll view). The web
  moves a smooth scroll of the core's in flight with a `ScrollBy` (`op_sb`), as the native backends move theirs:
  setting the offset would stop it. Lists of their own pay nothing:
  every step is reached through a list in parent mode, and a plain scroll view checks an empty list
  (`crates/nsh-core/src/core/parent_viewport.rs`).
- **List internals** (the window, binding cells, recycling): `crates/nsh-core/src/core/list.rs`.
- **JS cell binding**: the host publishes a list's source with the count and splice operations returned by
  `Host::take_ops`. A pending core bind reads that published source, even if JS has already queued another source
  change. Each cell owns its item and index signals; a bind resolves the item first, then updates both in one batch.
  Surviving keyed children retain their owners and local state across insertions and removals. Replacements reach
  the child when the core processes their splice and binds the cell; signals inside a bound item remain reactive.
- **Indexed data**: TSX `each` also accepts `ReadonlyListSource<T>`, a readonly snapshot with `length` and `at(index)`.
  Only bound and viewable items are read. Replacing a snapshot's identity replaces the full range without reading its
  items; arrays retain their identity-based common-prefix / suffix splice behavior. Counts use the core's existing u32 range.
- **Paced binding** (the runtime's lists): the window keeps a viewport of overscan on either side, and a fast scroll or
  a jump assigns a screen of cells at once, updating each cell's item and index signals together. What shows binds in
  the commit that assigns it: the viewport, two scroll steps ahead of it, sticky items and cells whose item moved (a splice tells them
  their new index). The rest of the overscan waits in the core (`Slot::requested`: what JS was last asked to show, so
  nothing stale is queued and cells whose items went are never asked for) and the engine binds it as its per-turn
  budget allows (`PACED_BIND_OPS` ops or `PACED_BIND_TIME` of JS, at least one cell; nearest the leading edge first,
  one cell per list in turn), then on the next display frames (`MountSink::request_frame`). Cells assigned but not
  bound yet are moved out of sight like unassigned ones. Rust components' lists bind in the core, unpaced.
- **Rust components**: the same props are `Scrollable`'s methods (`scroll()`, `virtual_list(..)`) and
  `VirtualList`'s (header, footer, empty view, separators, sticky rows, viewability); `docs/dev/components.md`.
