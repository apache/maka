import { mount, signal, Text, View } from "nsh";
import { AlertDialog, Button } from "nsh/base";
import { button, buttonText, desktop, focusRing, hoverFill, Inspector, Panel, size, Stage, ui, wide } from "./palette";

type Options = Parameters<typeof AlertDialog.show>[0];

// What each button shows, and what it is about.
const alerts: { label: string; detail: string; danger?: boolean; options: Options }[] = [
  {
    label: "Delete…",
    detail: "cancel + destructive roles",
    danger: true,
    options: {
      title: "Delete the photo?",
      description: "This cannot be undone.",
      actions: [
        { label: "Cancel", role: "cancel" },
        { label: "Delete", role: "destructive", id: "delete" },
      ],
    },
  },
  {
    label: "Save changes…",
    detail: "three actions, closeOnEscape",
    options: {
      title: "Save changes?",
      description: "Your edits to “Trip notes” are not saved yet.",
      actions: [
        { label: "Don't save", role: "destructive", id: "discard" },
        { label: "Cancel", role: "cancel" },
        { label: "Save", id: "save" },
      ],
      closeOnEscape: true,
    },
  },
  {
    label: "Share…",
    detail: 'presentation "actionSheet"',
    options: {
      title: "Share the photo",
      presentation: "actionSheet",
      actions: [
        { label: "Copy link", id: "copy" },
        { label: "Save", id: "save" },
        { label: "Delete", role: "destructive", id: "delete" },
        { label: "Cancel", role: "cancel" },
      ],
    },
  },
];

function App() {
  const answer = signal("–");
  const shown = signal(0);
  const show = async (options: Options) => {
    shown.update((n) => n + 1);
    const choice = await AlertDialog.show(options);
    answer.set(choice === null ? "null (closed without an action)" : JSON.stringify(choice));
  };
  const row = () => ({ ...ui().row, borderRadius: 12, padding: 14, gap: 2 });
  const hint = desktop ? "Escape or a click outside the action sheet closes it with null." : "A tap outside the action sheet closes it with null.";
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>alert-dialog</Text>
      <Text style={{ color: ui().muted }}>The platform's own alert; every label comes from the app.</Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            {/* A row per alert: what it shows, and a button as wide as its label at the end. */}
            <Stage width={400}>
              <View style={{ ...ui().card, borderRadius: 14, overflow: "hidden" }}>
                <Each of={alerts}>
                  {(a, i) => (
                    <>
                      {i() > 0 ? <View style={{ height: 1, marginLeft: 12, backgroundColor: ui().line }} /> : null}
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: size.row + 4, paddingHorizontal: 12 }}>
                        <Text style={{ flex: 1, fontSize: 13, color: ui().muted }}>{a().detail}</Text>
                        <Button onPress={() => show(a().options)} {...button()}>
                          <Text style={{ ...buttonText(), color: a().danger ? ui().down : ui().text }}>{a().label}</Text>
                        </Button>
                      </View>
                    </>
                  )}
                </Each>
              </View>
            </Stage>
            <Inspector>
              <Panel title={`AlertDialog.show resolved with (${shown()} shown)`}>
                <Text style={{ color: ui().accent, fontSize: 14, fontWeight: "600" }}>{answer()}</Text>
              </Panel>
              <Text style={{ color: ui().faint, fontSize: 12 }}>{hint}</Text>
            </Inspector>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <Each of={alerts}>
              {(a) => (
                <Button onPress={() => show(a().options)} style={row()} activeStyle={{ opacity: 0.7 }} hoverStyle={hoverFill()} focusStyle={focusRing()}>
                  <Text style={{ color: a().danger ? ui().down : ui().text, fontSize: 16, fontWeight: "600" }}>{a().label}</Text>
                  <Text style={{ color: ui().muted, fontSize: 13 }}>{a().detail}</Text>
                </Button>
              )}
            </Each>

            <View style={{ ...ui().inset, borderRadius: 12, padding: 14, gap: 4, marginTop: 4 }}>
              <Text style={{ color: ui().muted, fontSize: 13 }}>AlertDialog.show resolved with ({shown()} shown)</Text>
              <Text style={{ color: ui().accent, fontSize: 16, fontWeight: "600" }}>{answer()}</Text>
            </View>
            <Text style={{ color: ui().faint, fontSize: 13 }}>{hint}</Text>
          </View>
        )
      }
    </View>
  );
}

mount(App);
