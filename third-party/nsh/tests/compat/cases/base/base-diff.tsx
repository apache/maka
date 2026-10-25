// A case of the API's test suite (docs/dev/compatibility.md): `DiffView`
// of `nsh/base`, the changes between two texts the app owns (`oldValue`,
// `newValue`): the unchanged lines beyond `contextLines` around each
// change collapse into separators the app draws (`renderSeparator`, told
// the gap and how many lines), which the ref expands (`expand`); each
// change carries the app's actions (`renderHunkActions`, told the hunk),
// which revert or keep it through the ref (`revertHunk`, `acceptHunk`),
// reported with both texts (`onChange`) for the app to set; the ref
// reads the changes (`hunks`) and their counts (`stats`), and moves from
// change to change (`nextHunk`, `currentHunk`). The app's `annotations`
// show under their lines (`renderAnnotation`). A unified `patch` shows its
// hunks under their headers; with `softWrap` its long line wraps. Pressing
// a line number selects its line (`onLineSelectionChange`,
// `onLineNumberPress`), where the app's add control shows
// (`renderAddAnnotation`); the ref reads the selection (`selectedLines`,
// `selectedText`) and sets it (`setSelectedLines`). A patch of two files
// shows each under the app's header (`renderFileHeader`, told the file),
// which collapses it through the ref (`toggleFile`), reported
// (`onFileToggle`); the ref lists the files (`files`), whose changes
// count across them.
import { Text, View, signal } from "nsh";
import { DiffView, type DiffViewRef } from "nsh/base";

const OLD = "a\nb\nc\nd\ne\nf\ng\nh\n";
const NEW = "a\nB\nc\nd\ne\nf\nG\nh\n";
const PATCH = `--- a/main.rs
+++ b/main.rs
@@ -1,3 +1,3 @@ fn main
 one
-two
+TWO
 three
`;
const LONG = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
const ADDED = `--- a/notes.txt
+++ b/notes.txt
@@ -41,0 +42 @@
+${LONG}
`;
const FILES = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 alpha
-beta
+BETA
diff --git a/b.ts b/b.ts
new file mode 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1 @@
+gamma
`;

export default function BaseDiff() {
  const oldValue = signal(OLD);
  const newValue = signal(NEW);
  const read = signal("none");
  const hunk = signal("none");
  const selection = signal("none");
  const pressed = signal("none");
  const selected = signal("none");
  let diff!: DiffViewRef;
  let added!: DiffViewRef;
  let files!: DiffViewRef;
  const listed = signal("none");
  const toggled = signal("none");
  const list = async () => {
    const all = (await files.files()).map(f => `${f.path}@${f.firstHunk}`);
    const hunks = (await files.hunks()).map(h => `${h.index}:${h.file}`);
    listed.set(`${all.join(" ")} hunks ${hunks.join(" ")}`);
  };
  const inspect = async () => {
    const stats = await diff.stats();
    const hunks = (await diff.hunks()).map(h => `${h.index}@${h.oldStart}:${h.oldLines}>${h.newStart}:${h.newLines}`);
    read.set(`+${stats.added} -${stats.deleted} ${stats.hunks} [${hunks.join(" ")}]`);
  };
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 390, height: 240 }}>
        <DiffView
          ref={r => (diff = r)}
          oldValue={oldValue()}
          newValue={newValue()}
          layout="unified"
          contextLines={1}
          renderSeparator={sep => <Text>{`Hidden ${sep.gap} ${sep.lines}`}</Text>}
          renderHunkActions={hunk => (
            <View style={{ flexDirection: "row" }}>
              <View testID={`revert-${hunk.index}`} onPress={() => diff.revertHunk(hunk.index)}>
                <Text>{`Revert ${hunk.index}`}</Text>
              </View>
              <View testID={`keep-${hunk.index}`} onPress={() => diff.acceptHunk(hunk.index)}>
                <Text>{`Keep ${hunk.index}`}</Text>
              </View>
            </View>
          )}
          onChange={change => {
            oldValue.set(change.oldValue);
            newValue.set(change.newValue);
          }}
          annotations={[{ id: "n1", side: "new", line: 1 }]}
          renderAnnotation={a => <Text>{`Note ${a.id}`}</Text>}
          style={{ flex: 1 }}
        />
      </View>
      <View style={{ width: 390, height: 120 }}>
        <DiffView
          patch={PATCH}
          renderSeparator={sep => <Text>{sep.header ? `Header ${sep.header.trim()}` : `Gap ${sep.lines}`}</Text>}
          style={{ flex: 1 }}
        />
      </View>
      <View style={{ width: 390, height: 120 }}>
        <DiffView
          ref={r => (added = r)}
          patch={ADDED}
          softWrap
          onLineSelectionChange={r => selection.set(r ? `${r.side} ${r.start}-${r.end}` : "none")}
          onLineNumberPress={l => pressed.set(`${l.side} ${l.line}`)}
          renderAddAnnotation={r => <Text>{`Add ${r.side} ${r.start}-${r.end}`}</Text>}
          style={{ flex: 1 }}
        />
      </View>
      <Text>{() => `Old: ${oldValue().trim().split("\n").join(" ")}`}</Text>
      <Text>{() => `New: ${newValue().trim().split("\n").join(" ")}`}</Text>
      <Text>{() => `Read: ${read()}`}</Text>
      <View testID="inspect" style={{ height: 20 }} onPress={inspect} />
      <View testID="expand" style={{ height: 20 }} onPress={() => diff.expand(1)} />
      <Text>{() => `Hunk: ${hunk()}`}</Text>
      <Text>{() => `Selection: ${selection()}`}</Text>
      <Text>{() => `Pressed: ${pressed()}`}</Text>
      <Text>{() => `Selected: ${selected()}`}</Text>
      <View testID="next" style={{ height: 20 }} onPress={async () => hunk.set(`${await diff.nextHunk()}`)} />
      <View
        testID="current"
        style={{ height: 20 }}
        onPress={async () => hunk.set(`current ${await diff.currentHunk()}`)}
      />
      <View
        testID="select"
        style={{ height: 20 }}
        onPress={async () => {
          await added.setSelectedLines(null);
          const none = await added.selectedLines();
          await added.setSelectedLines({ side: "new", start: 0, end: 5 });
          const r = await added.selectedLines();
          const text = await added.selectedText();
          selected.set(`${none === null} ${r?.side} ${r?.start}-${r?.end} ${text.split(" ")[0]}`);
        }}
      />
      <View style={{ width: 390, height: 160 }}>
        <DiffView
          ref={r => (files = r)}
          patch={FILES}
          layout="unified"
          renderFileHeader={file => (
            <View testID={`file-${file.index}`} onPress={() => files.toggleFile(file.path)}>
              <Text>{`File ${file.index} ${file.path} ${file.status} +${file.added} -${file.deleted}${file.collapsed ? " collapsed" : ""}`}</Text>
            </View>
          )}
          onFileToggle={file => toggled.set(`${file.path} ${file.collapsed}`)}
          style={{ flex: 1 }}
        />
      </View>
      <Text>{() => `Files: ${listed()}`}</Text>
      <Text>{() => `Toggled: ${toggled()}`}</Text>
      <View testID="files" style={{ height: 20 }} onPress={list} />
    </View>
  );
}
