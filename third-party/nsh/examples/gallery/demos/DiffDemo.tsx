import { signal, Text, View } from "nsh";
import { DiffView, type DiffStats, type DiffViewRef } from "nsh/base";
import { Button as GalleryButton, desktop, DiffHunkActions, Segmented } from "../ui";

// `nsh/base`'s `DiffView` lays the two texts out, highlights what changed
// within lines and collapses what did not; the texts are the app's: a
// change reverted or kept is reported (`onChange`) and set back here. The
// actions on each change and the navigator above are the app's, calling
// the ref.

const OLD = `import { signal, Text, View } from "nsh";

/** A counter that starts at zero. */
export function Counter() {
  const count = signal(0);
  const label = () => "Count: " + count();
  return (
    <View onPress={() => count.set(count() + 1)}>
      <Text>{label()}</Text>
    </View>
  );
}

/** Formats a number for the badge. */
function badge(n: number) {
  return n > 99 ? "99+" : String(n);
}

/** The step of each press. */
const STEP = 1;

export default Counter;
`;

const NEW = `import { computed, signal, Text, View } from "nsh";

/** A counter that starts at \`initial\`. */
export function Counter(props: { initial?: number }) {
  const count = signal(props.initial ?? 0);
  const label = computed(() => \`Count: \${count()}\`);
  return (
    <View onPress={() => count.set(count() + STEP)} class="p-4">
      <Text>{label()}</Text>
    </View>
  );
}

/** Formats a number for the badge. */
function badge(n: number) {
  return n > 999 ? "999+" : String(n);
}

/** The step of each press. */
const STEP = 2;

export default Counter;
`;

/** `git diff` of one file: shown as its hunks, each under its header. */
const PATCH = `diff --git a/src/layout.rs b/src/layout.rs
--- a/src/layout.rs
+++ b/src/layout.rs
@@ -12,6 +12,7 @@ impl Layout {
     pub fn measure(&mut self, node: NodeId, available: Size) -> Size {
         let style = self.style(node);
-        let size = taffy::compute(style, available);
+        let size = taffy::compute(style, available)
+            .max(style.min_size);
         self.cache.insert(node, size);
         size
     }
@@ -40,5 +41,5 @@ impl Layout {
     fn invalidate(&mut self, node: NodeId) {
-        self.cache.remove(&node);
+        self.cache.retain(|id, _| *id != node);
         for child in self.children(node) {
             self.invalidate(child);
         }
`;

/** A small secondary button (the gallery's `Button`, `buttonLook`). */
function Tool(props: { label: string; name: string; onPress: () => void; disabled?: boolean }) {
  return <GalleryButton label={props.name} accessibilityLabel={props.label} variant="secondary" size="small" disabled={props.disabled} onPress={props.onPress} />;
}

/**
 * Diff: `nsh/base`'s `DiffView` of an edited component, split or
 * unified, with a navigator between the changes, Revert and Keep on each
 * change, and a `git diff` patch shown as its hunks.
 */
export function DiffDemo() {
  const source = signal<"texts" | "patch">("texts");
  // Split while both sides have room; a narrow window starts unified, its
  // lines as wide as the view, so a change's actions cover less of them.
  const layout = signal<"split" | "unified">(desktop() ? "split" : "unified");
  const oldValue = signal(OLD);
  const newValue = signal(NEW);
  const stats = signal<DiffStats>({ added: 0, deleted: 0, hunks: 0 });
  const current = signal(0);
  const last = signal("");
  let diff: DiffViewRef | undefined;

  // The counts follow the texts: the view reports them as it diffs.
  const counted = ({ stats: s }: { stats: DiffStats }) => {
    stats.set(s);
    current.set(Math.min(current(), Math.max(0, s.hunks - 1)));
  };

  const go = (index: number) => {
    current.set(index);
    diff?.goToHunk(index);
  };

  return (
    <View class="flex-1 gap-3 bg-background p-4">
      <View class="flex-row flex-wrap items-center gap-3">
        <View class="w-[200px]">
          <Segmented
            options={[
              { value: "texts", label: "Texts" },
              { value: "patch", label: "Patch" },
            ]}
            value={source()}
            onChange={(value) => source.set(value)}
            size="small"
          />
        </View>
        <View class="w-[200px]">
          <Segmented
            options={[
              { value: "split", label: "Split" },
              { value: "unified", label: "Unified" },
            ]}
            value={layout()}
            onChange={(value) => layout.set(value)}
            size="small"
          />
        </View>
      </View>

      <If when={source() === "texts"}>
        <View class="flex-row flex-wrap items-center gap-2">
          <Text class="font-mono text-[12px] tabular-nums text-foreground">
            {`+${stats().added} −${stats().deleted} · ${stats().hunks === 0 ? "No changes" : `Change ${current() + 1} of ${stats().hunks}`}`}
          </Text>
          <View class="flex-1" />
          <Tool label="Previous change" name="↑" disabled={current() <= 0} onPress={() => go(current() - 1)} />
          <Tool label="Next change" name="↓" disabled={current() >= stats().hunks - 1} onPress={() => go(current() + 1)} />
          <Tool label="Expand all" name="Expand" onPress={() => diff?.expandAll()} />
          <Tool label="Collapse all" name="Collapse" onPress={() => diff?.collapseAll()} />
          <Tool
            label="Reset"
            name="Reset"
            onPress={() => {
              oldValue.set(OLD);
              newValue.set(NEW);
              last.set("Reset");
            }}
          />
        </View>
      </If>

      <View class="flex-1 overflow-hidden rounded-lg border border-border bg-card">
        {() =>
          source() === "texts" ? (
            <DiffView
              ref={(r) => (diff = r)}
              onStatsChange={counted}
              oldValue={oldValue()}
              newValue={newValue()}
              language="tsx"
              layout={layout()}
              renderHunkActions={(hunk) => (
                <DiffHunkActions
                  index={hunk.index}
                  iconOnly={!desktop()}
                  onRevert={() => diff?.revertHunk(hunk.index)}
                  onKeep={() => diff?.acceptHunk(hunk.index)}
                />
              )}
              onChange={({ change }) => {
                oldValue.set(change.oldValue);
                newValue.set(change.newValue);
                last.set("Changed");
              }}
              onLineNumberPress={({ line }) => last.set(`Comment on ${line.side} line ${line.line + 1}`)}
              class="flex-1"
            />
          ) : (
            <DiffView
              patch={PATCH}
              onStatsChange={counted}
              layout={layout()}
              indicators="classic"
              renderSeparator={(sep) => (
                <View class="flex-1 flex-row items-center gap-2 bg-muted px-3">
                  <Text class="font-mono text-[11px] text-muted-foreground">{sep.header ? `@@ ${sep.header.trim()}` : `${sep.lines} lines`}</Text>
                </View>
              )}
              onLineNumberPress={({ line }) => last.set(`Comment on ${line.side} line ${line.line + 1}`)}
              class="flex-1"
            />
          )
        }
      </View>

      {/* What the last action did; nothing until there is one. */}
      <If when={last()}>
        <Text class="font-mono text-[11px] text-muted-foreground">{last()}</Text>
      </If>
    </View>
  );
}
