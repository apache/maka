import { mount, signal, Text, View } from "nsh";
import { Pagination } from "nsh/base";
import { desktop, Log, Panel, Segmented, Split, ui, wide, sectionSurface, paginationArrows, paginationItemClass } from "./palette";

// Search results paged with a count, and a compact pager beside them. The
// look is the shared one: `paginationItemClass` styles the items (quiet
// until hovered, the current page lit as a primary button, citrus under
// dark text, with `transition-colors`, still with reduced motion; the ends
// dimmed; 44 points tall on a touch screen, outlined in the compact pager),
// and `paginationArrows` draws Previous and Next as chevrons, so each pager
// fits one line of a phone. Five pages show in a narrow frame, seven in a
// wide one.
const itemClass = paginationItemClass();

const total = 238;
const page = signal(1);
const perPage = signal<"10" | "25">("10");
const chapter = signal(1);
const events = signal<string[]>([]);

const pages = () => Math.ceil(total / Number(perPage()));
const first = () => (page() - 1) * Number(perPage()) + 1;
const last = () => Math.min(page() * Number(perPage()), total);

const changed = (next: number) => {
  page.set(next);
  events.set([`onChange({ page: ${next} })`, ...events()].slice(0, 4));
};

function App() {
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>pagination</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click a page, or Tab to one and press Return" : "Tap a page"}</Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="page · totalPages">
              <Text style={{ fontSize: 13, color: ui().text }}>{`${page()} of ${pages()}`}</Text>
            </Panel>
            <Log title="onChange({ page })" lines={events()} minHeight={110} />
          </>
        }
      >
        <View style={{ ...sectionSurface({ padded: true }), gap: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <Text style={{ fontSize: 13, color: ui().muted }}>{`Showing ${first()}–${last()} of ${total} results`}</Text>
            <Segmented
              options={["10", "25"] as const}
              value={perPage()}
              onChange={(next) => {
                const row = first();
                perPage.set(next);
                page.set(Math.floor((row - 1) / Number(next)) + 1);
              }}
            />
          </View>
          <Pagination
            page={page()}
            totalPages={pages()}
            visiblePages={wide() ? 7 : 5}
            accessibilityLabel="Search results pages"
            previousAccessibilityLabel="Previous"
            nextAccessibilityLabel="Next"
            class="gap-1 flex-wrap"
            itemClass={itemClass}
            renderItem={paginationArrows}
            onChange={({ page: next }) => changed(next)}
          />
          <View style={{ height: 1, backgroundColor: ui().line }} />
          <Pagination
            compact
            page={chapter()}
            totalPages={12}
            accessibilityLabel="Chapters"
            previousAccessibilityLabel="Previous chapter"
            nextAccessibilityLabel="Next chapter"
            class="items-center justify-between"
            itemClass={paginationItemClass({ outlined: true })}
            renderItem={paginationArrows}
            onChange={({ page: next }) => chapter.set(next)}
          >
            <Text style={{ fontSize: 13, color: ui().muted }}>{`Chapter ${chapter()} of 12`}</Text>
          </Pagination>
        </View>
      </Split>
    </View>
  );
}

mount(App);
