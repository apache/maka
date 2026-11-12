// A case of the API's test suite (docs/dev/compatibility.md): the app's tray
// icon (`Tray.set`) with a title of colored runs, and its click, which
// carries the icon's frame on the screen where the system says where the
// icon is, `null` where it does not (Linux). The script clicks it as the
// platforms report a click.
import { Text, cleanup, signal } from "nsh";
import { Tray } from "nsh/desktop";

function App() {
  const clicks = signal<string[]>([]);
  Tray.set({
    tooltip: "API Desktop",
    // macOS shows it beside the icon; the script checks the click.
    title: [{ text: "API " }, { text: "Desktop", color: "#d92d20" }],
    onClick: ({ bounds }) =>
      clicks.set([
        ...clicks(),
        bounds === null
          ? "null"
          : `${bounds.origin.x} ${bounds.origin.y} ${bounds.size.width} ${bounds.size.height}`,
      ]),
  });
  cleanup(() => Tray.set(null));
  return <Text>{`Tray clicks: ${clicks().join(", ") || "none"}`}</Text>;
}

export default App;
