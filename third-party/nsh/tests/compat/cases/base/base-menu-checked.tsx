// A case of the API's test suite (docs/dev/compatibility.md): checkable
// items of `nsh/base`'s menus, on a phone (the menu a sheet). `MenuItem`'s
// `checked` makes an item checkable: a `menuitemcheckbox` for screen
// readers, checked or not, or with `role="menuitemradio"` one choice of a
// group; `checkedStyle` styles it while checked, and the indicator part
// (`indicatorClass`, `indicatorStyle`) around the app's mark (`indicator`),
// whose `checked:` and `disabled:` classes follow the item.
// Choosing one reports `onSelect` while the app owns the value, and closes
// the menu unless `closeOnSelect` is false. Its script checks each.
import { Text, View, signal } from "nsh";
import { Menu, MenuItem } from "nsh/base";

const part = "h-[10px] w-[10px] bg-[#111111] checked:bg-[#222222] disabled:bg-[#333333]";

function App() {
  const sidebar = signal(true);
  const sort = signal("name");
  const selects = signal(0);
  const choose = (by: string) => () => {
    selects.set(selects() + 1);
    sort.set(by);
  };
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Sidebar: ${sidebar()}`}</Text>
      <Text>{`Sort: ${sort()}`}</Text>
      <Text>{`Selects: ${selects()}`}</Text>
      <Menu trigger={<View style={{ height: 30 }}><Text>ViewTrigger</Text></View>}>
        <MenuItem
          testID="sidebar"
          class="flex-row"
          checked={sidebar()}
          closeOnSelect={false}
          checkedStyle={{ backgroundColor: "#00ff00" }}
          indicatorClass={part}
          indicatorStyle={{ opacity: 0.5 }}
          indicator={<View testID="sidebar-mark" class="h-[6px] w-[6px]" />}
          onSelect={() => {
            selects.set(selects() + 1);
            sidebar.set(!sidebar());
          }}
        >
          <Text>SidebarItem</Text>
        </MenuItem>
        <MenuItem
          testID="minimap"
          class="flex-row"
          checked={false}
          disabled
          indicatorClass={part}
          indicator={<View testID="minimap-mark" class="h-[6px] w-[6px]" />}
        >
          <Text>MinimapItem</Text>
        </MenuItem>
        <MenuItem testID="sort-name" role="menuitemradio" checked={sort() === "name"} onSelect={choose("name")}>
          <Text>NameItem</Text>
        </MenuItem>
        <MenuItem testID="sort-size" role="menuitemradio" checked={sort() === "size"} onSelect={choose("size")}>
          <Text>SizeItem</Text>
        </MenuItem>
        <MenuItem testID="plain">
          <Text>PlainItem</Text>
        </MenuItem>
      </Menu>
    </View>
  );
}

export default App;
