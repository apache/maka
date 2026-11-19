// A case of the API's test suite (docs/dev/compatibility.md): `SplitView`
// of `nsh/base` on iOS, where a `UISplitViewController` shows the columns'
// `NavStack`s: each column's stack is laid out at the size of the view
// until the split reports its columns' own, its pages placed with their
// state; the visibility goes to the split as data.
import { Text, View, signal } from "nsh";
import { type ColumnVisibility, NavPage, NavStack, SplitView, createNavStack } from "nsh/base";

const sidebar = createNavStack(["sidebar"]);
const detail = createNavStack(["detail"]);

export default function BaseSplitView() {
  const visibility = signal<ColumnVisibility>("all");
  const reported = signal("none");
  return (
    <View style={{ paddingTop: 20 }}>
      <SplitView
        testID="split"
        style={{ height: 300 }}
        columnVisibility={visibility()}
        onColumnVisibilityChange={({ columnVisibility }) => reported.set(columnVisibility)}
        sidebar={<NavStack state={sidebar}>{() => <NavPage title="Sidebar"><Text>Sidebar column</Text></NavPage>}</NavStack>}
        detail={<NavStack state={detail}>{() => <NavPage title="Detail"><Text>Detail column</Text></NavPage>}</NavStack>}
      />
      <Text>{() => `Visibility ${visibility()} reported ${reported()}`}</Text>
      <View testID="detail-only" style={{ width: 20, height: 20 }} onPress={() => visibility.set("detailOnly")} />
    </View>
  );
}
