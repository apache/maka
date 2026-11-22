import { mount, signal, Text, View } from "nsh";
import { ContextMenu, MenuItem } from "nsh/base";

// A context menu whose open state the app owns, and a row beside it that
// takes secondary clicks of its own. The text lists the changes heard.
function App() {
  const open = signal(false);
  const changes = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 100 }}>
      <ContextMenu
        open={open()}
        onOpenChange={({ open: next }) => {
          open.set(next);
          changes.set(changes() + (next ? "o" : "c"));
        }}
        trigger={
          <View style={{ height: 60 }}>
            <Text>row</Text>
          </View>
        }
      >
        <MenuItem>
          <Text>menu-row</Text>
        </MenuItem>
      </ContextMenu>
      <View onContextMenu={() => {}} style={{ height: 60 }}>
        <Text>other</Text>
      </View>
      <Text>{`changes: ${changes()}`}</Text>
    </View>
  );
}

mount(App);
