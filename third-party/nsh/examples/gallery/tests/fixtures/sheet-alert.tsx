import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { AlertDialog, Button, Dialog, Sheet } from "nsh/base";

// Sheets whose button closes them and shows an alert in the same press:
// `Sheet` (its own motion out) and a page sheet `Dialog` (the system's).
// Also an alert shown just before a page sheet closes (the app closes it
// once the alert is up), and one shown while a sheet opens.
function App() {
  const sheet = signal(false);
  const page = signal(false);
  const answer = signal("none");
  const ask = async (title: string) => {
    answer.set("asking");
    const { action } = await AlertDialog.show({
      title,
      actions: [{ label: "OK", id: "ok" }],
    });
    answer.set(action ?? "dismissed");
  };
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24, gap: 12 }}>
      <Text>{`answer: ${answer()}`}</Text>
      <Button onPress={() => sheet.set(true)}>
        <Text>Open sheet</Text>
      </Button>
      <Button onPress={() => page.set(true)}>
        <Text>Open page sheet</Text>
      </Button>
      <Button
        onPress={() => {
          sheet.set(true);
          void ask("Opening");
        }}
      >
        <Text>Open sheet and ask</Text>
      </Button>
      <Sheet open={sheet()} onOpenChange={({ open }) => sheet.set(open)}>
        <View style={{ padding: 24, gap: 12, backgroundColor: "#fff" }}>
          <Text>In the sheet</Text>
          <Button
            onPress={() => {
              sheet.set(false);
              void ask("From the sheet");
            }}
          >
            <Text>Close sheet and ask</Text>
          </Button>
        </View>
      </Sheet>
      <Dialog
        open={page()}
        presentation="pageSheet"
        onOpenChange={({ open }) => page.set(open)}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, padding: 24, gap: 12 }}>
          <Text>In the page sheet</Text>
          <Button
            onPress={() => {
              page.set(false);
              void ask("From the page sheet");
            }}
          >
            <Text>Close page sheet and ask</Text>
          </Button>
          <Button
            onPress={() => {
              void ask("Before the page sheet closes");
              setTimeout(() => page.set(false), 300);
            }}
          >
            <Text>Ask, then close page sheet</Text>
          </Button>
        </View>
      </Dialog>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
