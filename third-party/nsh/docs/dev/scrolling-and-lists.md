# Scrolling and lists

- **A resize keeps what a scroll view shows** (`core/resize_anchor.rs`): as a browser's scroll anchoring, in the layout
  after a change of the viewport a plain vertical scroll view past its start scrolls by as much as the first view it
  shows moved, with a `ScrollBy` in the same batch, clamped to its content. Text above the viewport wrapping onto more
  lines moves nothing on screen, through a window's drag and when text that waited catches up (`docs/dev/text.md`).
  Lists keep their rows themselves.
- **Scrolling**: `pagingEnabled`, `snapToInterval` / `snapToOffsets` / `snapToAlignment`, `disableIntervalMomentum`,
  `decelerationRate`, `scrollable`, `bounces`, `contentInset`, `contentOffset`, `keyboardShouldPersistTaps`
  (`never` / `handled` / `always`), `onScroll` (+ `scrollEventThrottle`; at most once per engine turn), `onScrollDragStart` /
  `EndDrag`, `onMomentumStart` / `End` (a glide caught by a new drag ends with `onMomentumEnd`). Snapping is decided
  by `ScrollBehavior::snap_target` (core) on iOS and its Java port on Android, from the release offset, the projected glide and
  the velocity. Lists scrolled past their start keep the visible rows in place when items are inserted above them
  (`splice`), as a browser's scroll anchoring does; at their start the rows that arrive show, unless the list loads
  pages at its start (`onLoadMoreAtStart`: the page it prepends keeps the rows in place there too).
- **Input**: fingers (and pens) drag scroll views; on the desktop backends and the web the mouse never does (dragging
  the content is a touchscreen's way to scroll): it scrolls with the wheel, the touchpad, the keyboard and the
  indicator (a scroll bar), and its drags are the app's (pans, responders, text selection). On Linux, Windows and desktop Web, the indicator shows while scrolling or when the pointer reaches its draggable thumb;
  moving over content leaves its visibility and fade timer unchanged. macOS follows the system's scroll-bar
  visibility preference (`WhenScrolling` suppresses content-hover reveal). `scrollbar={false}` hides the
  indicator on either axis (the platforms' `scroll::config`; on the web `barShown`, in the desktop idiom): a mouse
  without a horizontal wheel moves a horizontal view with Shift + wheel, with the vertical wheel where nothing
  around it scrolls vertically (`scroll_target`), and with the keys. With a
  mouse alone, pull to refresh needs a touchpad that rubber-bands (macOS): apps offer another way on the desktop.
- **Scroll bars of the app's own** (`nsh/base`'s `Scrollbar`, `docs/dev/components.md` "Scroll bars"): a view the
  app places that names a scroll view or a list (`scroll={ref}`), with its look (`class`, `thumbClass`) and `mode`;
  the target's own indicator off with `scrollbar={false}`. It follows the target through the core
  (`element::watch_scroll`: the offset every platform reports, the content size the layout sends), so it
  works on every backend, and scrolls it with `ScrollTo`. With an app theme (`Scrollbar.setTheme`) or a view's own
  (`scrollbar={{ … }}`) the core draws one over every such view in place of its indicator (`ScrollConfig.replaced`);
  `docs/dev/components.md` "Scroll bars".
- **Carousels** (`nsh/base`'s `Carousel`, `docs/dev/components.md` "Carousels"): a horizontal or vertical scroll view
  whose `snapToOffsets` are its slides' laid-out starts, with `disableIntervalMomentum`; the slide is read where the
  scroll comes to rest (`onScrollEnd`) and discrete changes are `ScrollTo`s.
- **Content container** (`<Scroll>`): `contentStyle` / `contentClass` are the renderers', each with a
  `scroll_content` (QuickJS' in `nsh-js`'s `dom.rs`, the browser runtime's in `nsh-platform-web`'s `browser/dom.rs`;
  a change to one goes to both): the first one set makes a view the scroll view's children move into (also the ones
  already there; later inserts and removals go to it), and styles it. The core lays a scroll view's children out in
  the scroll view itself, so without it nothing changes (no extra view).
- **Zooming** (`<Scroll>`, not lists): `maximumZoomScale` above `minimumZoomScale` makes the content zoomable; `zoomScale`
  zooms when it changes, `bouncesZoom`, `zoomable`, `centerContent` (content smaller than the viewport is centered);
  ref `zoomTo({ scale, x, y, animated })` (content point `x`, `y` in the middle); `onScroll` reports `zoomScale` and the zoomed
  content size. iOS: the children live in a `NshZoomView` (`zoom.rs`) that UIKit scales (`viewForZoomingInScrollView:`), its
  bounds the unzoomed content size, so the core's frames stay valid; texts and canvases are drawn again at the zoomed
  resolution when a zoom ends. Android has no zooming scroll view: `ScrollBox` switches to its `ZScroll`, which scales the
  content around its top left and scrolls both ways itself (ScaleGestureDetector around the focal point, panning with any
  number of fingers, OverScroller flings, rubber bands past the edges and the zoom limits). Pinches start only after
  Android's minimum span (about 27 mm between the fingers). Zoom reports go to the core (`EngineControl::zoom`).
- **List** props: `each`, `estimatedItemSize`, `numColumns` (both may change while the list shows: the first visible item keeps its place, `ListState::visible_anchor`; a change of columns remembers it in `columns_anchor`, so resizing back and forth does not drift), `inverted` (chat: item 0 at the bottom, starts at the end and keeps its
  distance from the end as content changes; with `onLoadMoreAtStart`, only while at it, the visible rows when scrolled away), `maintainVisibleContentPosition` (`autoscrollToBottomThreshold`: a list
  that is not inverted follows its end while within that distance of it, `ListState::anchor_end`; scrolled up, growth
  below the viewport moves nothing; Rust components: `ListLayout::follow_end`, on their own lists and the lists they place), `alignment` (`bottom`, GPUI's `ListAlignment::Bottom`: rows in reading order, opens at the end with no scroll command to pin, follows it within `follow_end` or a point's rounding, `ListState::anchor_end`; it waits for an appended last row's measurement the window will reach, so one scroll lands on its real size; short content lies at the bottom, `ListState::leading`), `stickyHeaderIndices` (one column, not inverted) + `stickyHeaderOffset` (where they stick: the core subtracts a number from the sticky ranges, so platforms pin as they do without one; an animated node rides along in `StickyCell::offset`, `ListState::sticky_node`, and the platforms add its value as they pin), `header` /
  `footer` / `empty` / `separator` (a component, called once and untracked, or an element; a signal or memo, as `<If>` and `<Each>` are, is the slot's insert's to track: `slot` in `nsh-js` `list.rs`, `web/browser/list.js`), `contentStyle`
  (padding and gaps, numbers) / `contentClass` (`p-*`, `gap-*`), `initialScrollAtEnd` (opens at the end before the first frame, keeps it while rows measure, and takes precedence over `initialScrollIndex`; short content stays at the top), `initialScrollIndex`, `onLoadMore` + `loadMoreThreshold`,
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
  the app prepends keeps the visible rows in place (`splice`, at the start too), so the list leaves the zone and the
  next approach fires again. The `onLoadMoreAtStart` listener also opts an inverted list
  into what that needs (rule 4 of `compatibility.md`: inverted lists without it behave as before): it keeps its
  distance from the end (the bottom) only while it is at its start, where item 0 shows (a chat's new message);
  scrolled away from it, a splice or a measurement before the viewport keeps the visible rows in place as on other
  lists (`ListState::loads_at_start`, `keeps_visible_rows`; `measured` returns what cancels `anchor_end`'s scroll).
- **Spare list cells** (recycled cells without an item) keep their last row. The core hides them (`Core::set_spare`:
  `visibility: hidden` and `accessibilityElementsHidden`) when they lie in the render window, were never placed or
  the items changed, and shows them as it places them; the few the window leaves behind while scrolling stay shown.
  A row coming back into the window takes back the spare cell that still shows it (the window shrank and grew back
  as a panel showed and went), so it is not made again; spare cells follow their rows through splices.
- **Kept rows**: a row holding the keyboard focus, an open overlay (a row's menu or popover; not a hint) or an end of
  a text selection stays bound wherever the list scrolls, so the field keeps the focus and the menu stays open
  (`Core::sync_kept`, each commit before the lists update). Once none is left in it, the row is recycled as any other.
  The rows on either side of the focused row are kept with it: the platforms' Tab and Shift+Tab reach only views that
  exist, so the next row is always there for them, however far the render window lags behind (keys repeating faster
  than the reveal scrolls, a runtime list binding its overscan paced, the list scrolled away from the focus); the row
  the focus reaches scrolls into view, which renders the rows around it.
- **Revealing a view** (`reveal`, `ElementRef::reveal`): a command on the view that the
  core turns into `ScrollTo` commands of the `Scroll`s around it at the commit, in place among the commands
  (`Core::reveal_scrolls`, `core/measure.rs`), innermost first, each from where the ones inside it end up and the
  commit's earlier scroll commands put it (`Core::scrolled_to`) or, before that, where the last `ScrollTo` sent in an
  earlier commit goes until a report shows it applied (`ScrollState::target`, by the platforms' count of applied
  scrolls), along each scroll view's axis and clamped to the range the platforms scroll over (the content widened by
  `contentInset`: `-inset.leading ..= content + inset.trailing - viewport`); a scroll view already where it would go
  gets none, even at an offset outside that range (insets UIKit adds that the core does not know). `start` / `end` are
  physical along `horizontal` (left / right, RTL too). It walks the frames as `measure()` does: transforms and a `zoomTo`
  not reported yet are not taken into account. Lists are passed through (their offsets are their rows', `scrollToIndex`'s); platforms
  never see the command.
- **List scroll commands**: the core resolves a list's `scrollToEnd` / `scrollToIndex` to a `ScrollTo` with the sizes it
  knows, which are estimates for rows never rendered; the target stays pinned (`ListState::follow_pin`), and as the rows
  around it are measured the list follows it (a `ScrollBy`, or a retargeted `ScrollTo` while an animated scroll is in
  flight) until the rows in the viewport are all measured, the user scrolls away or the items change. Platforms only
  apply what they get.
- **Reading position** (`ListRef.measureScrollPosition()`, `ElementRef::measure_scroll_position`): answered by
  the core at the commit, as `measure()` is, from the list's own row positions (`ListState::scroll_position`,
  `Core::list_scroll_position`): the row the viewport starts in and how far into it, so an app keeps a reading
  position without adding up row sizes of its own, which would miss the rows the list measured but whose cells it
  recycled before placing them, and the estimates it uses for the rest. `scrollToIndex` with `viewOffset: -offset`
  restores it. Platforms never see the command.
- **Lists in their parent's viewport** (`viewport="parent"`, `ListLayout::viewport(ListViewport::Parent)`; `own`,
  the default, is a scroll view of its own): fixed when the list's native view is made (a change in the batch that
  makes it counts; later ones warn once). The list mounts as a plain view clipping its cells and lies in its parent's layout at its full length (padding,
  border and size limits as in a browser); its view is the nearest scroll view or own list around it on its axis,
  else the root view it is in. The window, `onLoadMore`, viewability and pins run unchanged in list coordinates.
  Anchoring is a browser's: the view moves only for rows measured or spliced wholly above its viewport's top while
  the list's start is scrolled past; `scrollToIndex`, `scrollToEnd` and `initialScrollIndex` scroll the view,
  clamped to its content. The scroll view's props (`onScroll` and the other scroll events, `scrollValue`,
  `refreshing`, `refreshIndicator`, `pullValue`, paging and snapping, `contentInset`, `scrollbar`, `scrollable`,
  `keyboardDismissMode`) and what needs a scroll view of the list's own (`inverted`,
  `maintainVisibleContentPosition`) are ignored there, each warned of once; a zoomable scroll view around it is not
  supported. Sticky rows stick to the view's viewport, as CSS `position: sticky` in its container. Its props carry
  `ViewProps::screen_order` (its axis): the platforms read its cells in the order they are on screen, as they read a
  scroll view's content, since recycled cells are not in their rows' order in the tree. Lists of their
  own pay nothing (`crates/nsh-core/src/core/parent_viewport.rs`).
- **List internals** (the window, binding cells, recycling): `crates/nsh-core/src/core/list.rs`.
- **Paced binding** (the runtime's lists): what shows binds in the commit that assigns it (the viewport, sticky items,
  cells whose item moved); the rest of the overscan is bound by the engine over the following turns and frames
  within a budget. Cells assigned but not bound yet are moved out of sight like unassigned ones. Rust components'
  lists bind in the core, unpaced.
- **Rust components**: the same props are `Scrollable`'s methods (`scroll()`, `virtual_list(..)`) and
  `VirtualList`'s (header, footer, empty view, separators, sticky rows, viewability); `docs/dev/components.md`.
