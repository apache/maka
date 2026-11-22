import { List, mount, Scroll, signal, Text, View } from "nsh";
import { Button, Dialog, Input, Sheet } from "nsh/base";

const people = ["Alice", ...Array.from({ length: 39 }, (_, i) => `Person ${i + 2}`)];

// A page sheet dialog written inside the page's scroll view, a list at its
// top, and a sheet shown from it.
function App() {
  const dialog = signal(false);
  const inner = signal(false);
  const sheet = signal(false);
  const picked = signal("none");
  const query = signal("");
  const invite = signal("");
  const note = signal("");
  return (
    <Scroll style={{ flex: 1, marginTop: 120 }}>
      <View style={{ padding: 24, gap: 12 }}>
        <Text>{`picked: ${picked()}`}</Text>
        <Text>{`invite: ${invite()}`}</Text>
        <Text>{`note: ${note()}`}</Text>
        <Button onPress={() => dialog.set(true)}>
          <Text>Open dialog</Text>
        </Button>
        <Button onPress={() => sheet.set(true)}>
          <Text>Open sheet</Text>
        </Button>
        <Dialog open={dialog()} presentation="pageSheet" closeOnSwipe onOpenChange={({ open }) => dialog.set(open)} style={{ flex: 1 }}>
          <View style={{ flex: 1, paddingTop: 24 }}>
            <Input testID="search" placeholder="Search" autoCapitalize="none" value={query()} onChange={({ value }) => query.set(value)} style={{ height: 40, marginHorizontal: 24 }} />
            <List testID="people" keyboardShouldPersistTaps="handled" each={people.filter((p) => p.toLowerCase().startsWith(query().toLowerCase()) || p === "Alice")} estimatedItemSize={44} style={{ flex: 1 }}>
              {(name) => (
                <View role="button" onPress={() => picked.set(name())} style={{ height: 44, justifyContent: "center", paddingHorizontal: 24 }}>
                  <Text>{name()}</Text>
                </View>
              )}
            </List>
            <Button onPress={() => inner.set(true)} style={{ margin: 24 }}>
              <Text>Invite</Text>
            </Button>
            <Sheet open={inner()} onOpenChange={({ open }) => inner.set(open)}>
              <View style={{ padding: 24, gap: 12 }}>
                <Input testID="invite-input" placeholder="Message" multiline autoCapitalize="none" value={invite()} onChange={({ value }) => invite.set(value)} style={{ height: 80 }} />
              </View>
            </Sheet>
          </View>
        </Dialog>
        <Sheet open={sheet()} onOpenChange={({ open }) => sheet.set(open)}>
          <View style={{ padding: 24, gap: 12 }}>
            <Input testID="sheet-input" placeholder="Note" multiline autoCapitalize="none" value={note()} onChange={({ value }) => note.set(value)} style={{ height: 80 }} />
          </View>
        </Sheet>
      </View>
    </Scroll>
  );
}

mount(App);
