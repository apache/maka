import { platform, signal, Text, View } from "nsh";
import { Menu, MenuItem, Pagination, type PaginationItemState } from "nsh/base";
import { Appear, Button, Caption, Card, colors, DemoPage, density, Icon, mono, PopIn, popupSurface, Segmented, Toggle } from "../ui";

// `nsh/base`'s `Pagination` owns which pages show (the first and the last,
// the current one's neighbours, ellipses for the rest), the presses,
// Previous and Next going disabled at the ends, the keyboard focus and the
// navigation landmark; the page is the app's. The look is the gallery's,
// all in `itemClass`: quiet items that the current page lights in the brand
// color (`selected:`), fading between pages with `transition-colors`, the
// ends dimmed (`disabled:`); the items show the component's own numbers
// and labels, so a page change only changes texts and states. The archive
// alone draws its items (`renderItem`), for the menu its ellipses open.
// The rows of a page fade in when it changes. Nothing moves with reduced
// motion.

const pointer = platform.desktop;

/** Every item's look: the current page `selected:`, the ends `disabled:`. */
const itemClass =
  "min-w-8 h-8 px-2 flex-row items-center justify-center gap-1 rounded-md text-sm text-foreground " +
  "transition-colors duration-200 motion-reduce:transition-none hover:bg-hover active:opacity-70 " +
  "selected:bg-brand selected:text-on-brand disabled:opacity-35 focus:outline-2 focus:outline-ring";

/** `n` with thousands separators, the same on every platform. */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The pages an ellipsis menu lists: those it hides nearest the current page, at most 100. */
function hiddenPages(start: number, end: number, current: number) {
  const last = 100;
  const [from, to] = end - start <= last ? [start, end] : start > current ? [start, start + last] : [end - last, end];
  return Array.from({ length: to - from }, (_, i) => from + i);
}

const sheet = pointer
  ? undefined
  : { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 34 };

/** An ellipsis that opens a menu of the pages it hides (`gpui-component`'s dropdown). */
function JumpMenu(props: { start: number; end: number; current: number; onPick: (page: number) => void }) {
  const pages = () => hiddenPages(props.start, props.end, props.current);
  const list = (
    <Each of={pages()}>
      {(page) => (
        <MenuItem
          onSelect={() => props.onPick(page())}
          hoverStyle={{ backgroundColor: colors.inset }}
          style={{ height: pointer ? 28 : 44, paddingHorizontal: 10, justifyContent: "center", borderRadius: 6 }}
        >
          <Text style={{ fontSize: density.body, color: colors.text, fontVariant: ["tabular-nums"] }}>{grouped(page())}</Text>
        </MenuItem>
      )}
    </Each>
  );
  return (
    <Menu
      offset={4}
      margin={8}
      popupStyle={sheet}
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.45)" }}
      trigger={
        <View
          accessibilityLabel={`Pages ${grouped(props.start)} to ${grouped(props.end - 1)}`}
          class="min-w-8 h-8 items-center justify-center rounded-md hover:bg-hover"
        >
          <Text style={{ color: colors.muted, fontSize: density.body }}>…</Text>
        </View>
      }
    >
      {pointer ? (
        <PopIn style={{ ...popupSurface(), minWidth: 80, maxHeight: 240 }}>{list}</PopIn>
      ) : (
        <View style={{ maxHeight: 360 }}>{list}</View>
      )}
    </Menu>
  );
}

/**
 * Pagination: search results with a count, a table's footer with its page
 * size, a compact pager for a phone, and an archive of ten thousand pages
 * with jump menus and an offline state.
 */
export function PaginationDemo() {
  function Results() {
    const total = 238;
    const perPage = 10;
    const pages = Math.ceil(total / perPage);
    const page = signal(1);
    const first = () => (page() - 1) * perPage + 1;
    const last = () => Math.min(page() * perPage, total);
    const rows = () => Array.from({ length: last() - first() + 1 }, (_, i) => first() + i);
    return (
      <Card title="Search results" subtitle={`“native shell”: ${total} results`}>
        <View style={{ gap: 6, minHeight: pointer ? 260 : 320 }}>
          <Each of={rows()} key={(n) => n}>
            {(n, i) => (
              <Appear index={i()}>
                <View style={{ gap: 2, paddingVertical: 4 }}>
                  <Text style={{ fontSize: density.body, fontWeight: "500", color: colors.accent }}>{`Result ${n()}: Native views for generated UI`}</Text>
                  <Text style={{ fontSize: 12, color: colors.faint }}>{`docs.example.com/guide/${n()}`}</Text>
                </View>
              </Appear>
            )}
          </Each>
        </View>
        <View style={{ gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line, alignItems: pointer ? "flex-start" : "center" }}>
          <Pagination
            page={page()}
            totalPages={pages}
            visiblePages={pointer ? 7 : 5}
            accessibilityLabel="Search results pages"
            previousAccessibilityLabel="Previous"
            nextAccessibilityLabel="Next"
            class="gap-1 flex-wrap"
            itemClass={itemClass}
            onChange={({ page: next }) => page.set(next)}
          />
          {/* Full width: the caption's label grows, which a centered column would squeeze to nothing. */}
          <View style={{ alignSelf: "stretch" }}>
            <Caption label={`Showing ${first()}–${last()} of ${total}`} note={`page ${page()} of ${pages}`} />
          </View>
        </View>
      </Card>
    );
  }

  function TableFooter() {
    const orders = 1284;
    const sizes = ["10", "25", "50"] as const;
    const size = signal<(typeof sizes)[number]>("25");
    const page = signal(1);
    const per = () => Number(size());
    const pages = () => Math.ceil(orders / per());
    const first = () => (page() - 1) * per() + 1;
    const last = () => Math.min(page() * per(), orders);
    const shown = () => Array.from({ length: Math.min(4, last() - first() + 1) }, (_, i) => first() + i);
    return (
      <Card title="Table footer" subtitle="Newest orders first; a page size that keeps the first row in view">
        <View style={{ gap: 2 }}>
          <Each of={shown()} key={(n) => n}>
            {(n) => (
              <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line }}>
                <Text style={{ fontSize: density.body, color: colors.text, fontFamily: mono }}>{`#${20000 - n()}`}</Text>
                <Text style={{ fontSize: density.body, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`$${((n() * 37) % 900) + 20}.00`}</Text>
              </View>
            )}
          </Each>
          <Text style={{ fontSize: 12, color: colors.faint, paddingTop: 4 }}>{`and ${last() - first() + 1 - shown().length} more on this page`}</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 12, color: colors.muted }}>Rows per page</Text>
            <Segmented
              size="small"
              options={sizes.map((s) => ({ value: s, label: s }))}
              value={size()}
              onChange={(next) => {
                // The row at the top stays on the page shown.
                const row = first();
                size.set(next);
                page.set(Math.floor((row - 1) / Number(next)) + 1);
              }}
            />
          </View>
          <Pagination
            page={page()}
            totalPages={pages()}
            accessibilityLabel="Orders pages"
            previousAccessibilityLabel="Newer"
            nextAccessibilityLabel="Older"
            class="gap-1"
            itemClass={itemClass}
            onChange={({ page: next }) => page.set(next)}
          />
        </View>
        <Caption label={`Rows ${grouped(first())}–${grouped(last())} of ${grouped(orders)}`} note={`${pages()} pages`} />
      </Card>
    );
  }

  function Compact() {
    const chapters = ["Arrival", "The Harbor", "Old Maps", "Low Tide", "The Lighthouse", "Fog", "Signals", "The Crossing", "North Shore", "Embers", "Return", "Afterword"];
    const page = signal(1);
    return (
      <Card title="Compact" subtitle="Previous, the page in words, Next: a reader on a phone">
        <View style={{ gap: 4, paddingVertical: 8 }}>
          <Text style={{ fontSize: 12, color: colors.faint, letterSpacing: 0.4 }}>{`CHAPTER ${page()}`}</Text>
          <Text style={{ fontSize: 20, fontWeight: "600", color: colors.text }}>{chapters[page() - 1]}</Text>
        </View>
        <Pagination
          compact
          page={page()}
          totalPages={chapters.length}
          accessibilityLabel="Chapters"
          previousAccessibilityLabel="Previous chapter"
          nextAccessibilityLabel="Next chapter"
          class="items-center justify-between"
          itemClass={`${itemClass} px-3 h-10 border border-border`}
          onChange={({ page: next }) => page.set(next)}
        >
          <Text style={{ fontSize: density.body, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${page()} / ${chapters.length}`}</Text>
        </Pagination>
      </Card>
    );
  }

  function Archive() {
    const pages = 10000;
    const page = signal(5000);
    const visible = signal<"5" | "7" | "9">("7");
    const offline = signal(false);
    const log = signal<string[]>([]);
    const go = (next: number) => {
      page.set(next);
      log.set([`onChange({ page: ${next} })`, ...log()].slice(0, 3));
    };
    // The one pagination that draws its items: an ellipsis opens a menu of
    // the pages it hides, numbers get separators, Previous and Next are
    // chevrons. `renderItem` draws again every item whose state changed,
    // which a page change is for most of them; classes cost less.
    const draw = (item: PaginationItemState) => {
      if (item.kind === "ellipsis") return <JumpMenu start={item.start!} end={item.end!} current={page()} onPick={go} />;
      if (item.kind === "page") return <Text style={{ fontVariant: ["tabular-nums"] }}>{grouped(item.page)}</Text>;
      return (
        <View style={item.kind === "previous" ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <Icon name="chevron" size={14} tint={colors.muted} />
        </View>
      );
    };
    return (
      <Card
        title="Ten thousand pages"
        subtitle="An ellipsis opens the pages it hides; the same few items however many pages"
        right={<Toggle value={offline()} onChange={(v) => offline.set(v)} label="Offline" />}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 12, color: colors.muted }}>Pages shown</Text>
          <Segmented size="small" options={(["5", "7", "9"] as const).map((v) => ({ value: v, label: v }))} value={visible()} onChange={(v) => visible.set(v)} />
        </View>
        <Pagination
          page={page()}
          totalPages={pages}
          visiblePages={Number(visible())}
          disabled={offline()}
          accessibilityLabel="Archive pages"
          previousAccessibilityLabel="Previous archive page"
          nextAccessibilityLabel="Next archive page"
          class="gap-1 flex-wrap"
          itemClass={itemClass}
          renderItem={draw}
          onChange={({ page: next }) => go(next)}
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button label="First page" variant="ghost" size="small" disabled={offline() || page() === 1} onPress={() => go(1)} />
          <Button label="Last page" variant="ghost" size="small" disabled={offline() || page() === pages} onPress={() => go(pages)} />
        </View>
        <Caption label={offline() ? "Offline: no presses, no focus, dimmed for screen readers" : `Page ${grouped(page())} of ${grouped(pages)}`} />
        <View style={{ gap: 2, minHeight: 48 }}>
          <Each of={log()}>
            {(line, i) => <Text style={{ fontSize: 12, fontFamily: mono, color: i() === 0 ? colors.text : colors.faint }}>{line()}</Text>}
          </Each>
        </View>
      </Card>
    );
  }

  return <DemoPage cards={[Results, TableFooter, Compact, Archive]} />;
}
