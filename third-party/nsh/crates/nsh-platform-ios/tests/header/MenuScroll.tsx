import { mount, Scroll, signal, Text, View } from "nsh";
import { Button, Menu, MenuItem, NavPage, NavStack, createNavStack } from "nsh/base";

const rows = Array.from({ length: 60 }, (_, i) => i + 1);

/** A menu whose trigger is a button; its item changes nothing. */
function Actions(props: { id: string; label: string }) {
  return (
    <Menu
      trigger={
        <Button testID={props.id} accessibilityLabel={props.label} style={{ padding: 6 }}>
          <Text>{props.label}</Text>
        </Button>
      }
    >
      <MenuItem onSelect={() => {}}>
        <Text>{`Keep ${props.label}`}</Text>
      </MenuItem>
    </Menu>
  );
}

/** A page scrolled down a long list, with a menu in its header's trailing
 * slot and another in its content, and a label (nothing to press) in its
 * header's leading slot. */
function App() {
  const nav = createNavStack<"root">(["root"]);
  const offset = signal<number | undefined>(undefined);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {() => (
        <NavPage
          title="Rows"
          headerLeft={<Text testID="header-label">Label</Text>}
          headerRight={<Actions id="header-menu" label="Header" />}
        >
          <View style={{ flex: 1 }}>
            <Scroll testID="rows" style={{ flex: 1 }} onScroll={(e) => offset.set(Math.round(e.offset.y))}>
              <Each of={rows}>
                {(n) => (
                  <View style={{ height: 44, justifyContent: "center", paddingHorizontal: 16 }}>
                    <Text>{`Row ${n()}`}</Text>
                  </View>
                )}
              </Each>
            </Scroll>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12 }}>
              <Text>{`offset:${offset() ?? "none"}`}</Text>
              <Actions id="content-menu" label="Content" />
            </View>
          </View>
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
