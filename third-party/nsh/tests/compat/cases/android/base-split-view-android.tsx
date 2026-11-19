// A case of the API's test suite (docs/dev/compatibility.md): `SplitView`
// of `nsh/base` on a phone outside iOS (390 wide: horizontally compact).
// Its columns are the app's `NavStack`s (`sidebar`, `content`, `detail`)
// and one shows at a time: the first `columnVisibility` shows, which the
// app owns and changes (`automatic` the sidebar).
import { Text, View, signal } from "nsh";
import { type ColumnVisibility, NavPage, NavStack, SplitView, createNavStack } from "nsh/base";

const sidebar = createNavStack(["sidebar"]);
const content = createNavStack(["content"]);
const detail = createNavStack(["detail"]);

export default function BaseSplitViewAndroid() {
  const visibility = signal<ColumnVisibility>("automatic");
  const show = (id: string, next: ColumnVisibility) => (
    <View testID={id} style={{ width: 20, height: 20 }} onPress={() => visibility.set(next)} />
  );
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <View style={{ flexDirection: "row" }}>
        {show("show-all", "all")}
        {show("show-double", "doubleColumn")}
        {show("show-detail", "detailOnly")}
      </View>
      <SplitView
        style={{ flex: 1 }}
        columnVisibility={visibility()}
        sidebar={<NavStack state={sidebar}>{() => <NavPage title="Sidebar"><Text>Sidebar column</Text></NavPage>}</NavStack>}
        content={<NavStack state={content}>{() => <NavPage title="Content"><Text>Content column</Text></NavPage>}</NavStack>}
        detail={<NavStack state={detail}>{() => <NavPage title="Detail"><Text>Detail column</Text></NavPage>}</NavStack>}
      />
    </View>
  );
}
