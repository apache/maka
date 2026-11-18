import { horizontalSizeClass, type JSX, mount, Scroll, signal, Text, View } from "nsh";
import { Button, type ColumnVisibility, createNavStack, NavPage, NavStack, SplitView } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, Panel, Segmented, sectionSurface, Split, tint, ui, wide } from "./palette";

// `nsh/base`'s `SplitView`: three columns, each a `NavStack` of its own. The
// app owns which columns show (`columnVisibility`); on iOS the columns are a
// UISplitViewController's, here they stand side by side, and in a phone's
// width one shows at a time, the first the visibility shows.

/** One column shows where the window is horizontally compact. */
const compact = () => horizontalSizeClass() === "compact";

const folders = ["Inbox", "Drafts", "Archive"];
const notes: Record<string, string[]> = {
  Inbox: ["Design review", "Release notes", "Lunch next week"],
  Drafts: ["Quarterly update"],
  Archive: ["Conference badges"],
};
const visibilities: ColumnVisibility[] = ["all", "doubleColumn", "detailOnly"];

function App() {
  const visibility = signal<ColumnVisibility>("all");
  const folder = signal(folders[0]);
  const note = signal(notes.Inbox[0]);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  const sidebar = createNavStack(["folders"]);
  const list = createNavStack(["notes"]);
  const detail = createNavStack(["note"]);

  /** A row of a column: its title, its selection in the theme's tint. */
  const row = (title: string, selected: boolean, onPress: () => void) => (
    <Button
      onPress={onPress}
      accessibilityState={{ selected }}
      hoverStyle={selected ? undefined : { backgroundColor: hoverFill() }}
      focusVisibleStyle={focusRing()}
      style={{ paddingHorizontal: 12, paddingVertical: desktop ? 8 : 12, borderRadius: 6, backgroundColor: selected ? tint(ui().accent, 0.12) : "transparent" }}
    >
      <Text style={{ fontSize: 14, color: ui().text, fontWeight: selected ? "600" : "400" }}>{title}</Text>
    </Button>
  );
  /** A column's page: its title over its rows, on its surface. */
  const page = (title: string, surface: string, children: JSX.Element) => (
    <NavPage title={title} header={<Text style={{ paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, fontWeight: "600", color: ui().text }}>{title}</Text>}>
      <View style={{ flex: 1, backgroundColor: surface, borderEndWidth: 1, borderEndColor: ui().line }}>{children}</View>
    </NavPage>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>split view</Text>
      <Text style={{ color: ui().muted }}>
        {compact() ? "Pick a folder, then a note: each brings the next column in front" : "Choose which columns show; narrow the window to see one at a time"}
      </Text>
      <Split
        grow
        width={720}
        inspector={
          <>
            <Panel title="columnVisibility">
              <Segmented options={visibilities} value={visibility()} onChange={(next) => visibility.set(next)} />
            </Panel>
            <Log title="events" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 420 : 460, ...sectionSurface(), overflow: "hidden" }}>
          <SplitView
            style={{ flex: 1 }}
            columnVisibility={visibility()}
            onColumnVisibilityChange={({ columnVisibility }) => {
              visibility.set(columnVisibility);
              log(`onColumnVisibilityChange: ${columnVisibility}`);
            }}
            sidebar={
              <NavStack state={sidebar}>
                {() =>
                  page(
                    "Folders",
                    ui().inset.backgroundColor,
                    <Scroll style={{ flex: 1 }} contentStyle={{ padding: 6, gap: 2 }}>
                      {folders.map((f) =>
                        row(f, folder() === f, () => {
                          folder.set(f);
                          note.set(notes[f][0]);
                          if (compact()) visibility.set("doubleColumn");
                        }),
                      )}
                    </Scroll>,
                  )
                }
              </NavStack>
            }
            content={
              <NavStack state={list}>
                {() =>
                  page(
                    folder(),
                    ui().card.backgroundColor,
                    <Scroll style={{ flex: 1 }} contentStyle={{ padding: 6, gap: 2 }}>
                      {notes[folder()].map((n) =>
                        row(n, note() === n, () => {
                          note.set(n);
                          if (compact()) visibility.set("detailOnly");
                        }),
                      )}
                    </Scroll>,
                  )
                }
              </NavStack>
            }
            detail={
              <NavStack state={detail}>
                {() =>
                  page(
                    note(),
                    ui().card.backgroundColor,
                    <View style={{ flex: 1, padding: 16, gap: 10 }}>
                      <Text style={{ fontSize: 18, fontWeight: "600", color: ui().text }}>{note()}</Text>
                      <Text style={{ fontSize: 14, lineHeight: 20, color: ui().muted }}>{`In ${folder()}. Each column is a NavStack of its own, so its pages stay as the others change.`}</Text>
                      {compact() && row("Back to the notes", false, () => visibility.set("doubleColumn"))}
                    </View>,
                  )
                }
              </NavStack>
            }
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
