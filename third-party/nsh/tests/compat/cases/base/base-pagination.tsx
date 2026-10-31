// A case of the API's test suite (docs/dev/compatibility.md): `Pagination`
// of `nsh/base`, the pages of a set with no look of its own: the
// navigation landmark screen readers get (`accessibilityLabel`), the pages
// shown around the current one (`page`, `totalPages`, `visiblePages`), a
// press on a page, Previous or Next reported with `onChange` while the app
// owns the page, Previous and Next named for screen readers and disabled at
// the ends, the current page styled by the app's `selected:` class
// (`itemClass`, `itemStyle`), the app's children, `compact`, `disabled`,
// and the items the app draws (`renderItem`). Its script checks each.
import { Text, View, signal } from "nsh";
import { Pagination } from "nsh/base";

function App() {
  const page = signal(5);
  const drawn = signal(1);
  const compact = signal(false);
  const disabled = signal(false);
  const log = signal<string[]>([]);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 8 }}>
      <Pagination
        testID="pager"
        page={page()}
        totalPages={20}
        visiblePages={7}
        compact={compact()}
        disabled={disabled()}
        accessibilityLabel="Results"
        previousAccessibilityLabel="Previous"
        nextAccessibilityLabel="Next"
        class="gap-[2px]"
        itemClass="w-[30px] h-[30px] selected:bg-[#00ff00] disabled:opacity-50"
        itemStyle={{ fontSize: 12 }}
        onChange={({ page: next }) => {
          log.set([...log(), String(next)]);
          page.set(next);
        }}
      >
        <Text>{`Page ${page()} of 20`}</Text>
      </Pagination>
      <Pagination
        testID="drawn"
        page={drawn()}
        totalPages={10000}
        accessibilityLabel="Archive"
        previousAccessibilityLabel="Older"
        nextAccessibilityLabel="Newer"
        renderItem={(item) => (
          <Text>
            {item.kind === "ellipsis"
              ? `${item.start}-${(item.end ?? 0) - 1} hidden`
              : `${item.kind} ${item.page}${item.current ? " now" : ""}${item.disabled ? " off" : ""}`}
          </Text>
        )}
        onChange={({ page: next }) => drawn.set(next)}
      />
      <Text>{`Log: ${log().join(", ")}`}</Text>
      <View testID="compact" onPress={() => compact.set(!compact())} style={{ height: 20 }} />
      <View testID="disable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
