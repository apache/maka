// A case of the API's test suite (docs/dev/compatibility.md): `HoverCard` of
// `nsh/base` on a desktop: it opens once the pointer rested on its trigger
// for `openDelay`, stays open while the pointer is on the card, closes
// `closeDelay` after the pointer left both, and at once on Escape; it is
// made with its starting looks and stays with its ending looks through its
// transitions' 300 ms. Its script checks each.
import { Text, View, signal } from "nsh";
import { HoverCard } from "nsh/base";

function App() {
  const log = signal("Log: none");
  const life = signal("Life: none");
  return (
    <View style={{ flex: 1, paddingTop: 100, paddingLeft: 20, gap: 8 }}>
      <HoverCard
        openDelay={2000}
        closeDelay={2000}
        onOpenChange={({ open, reason }) => log.set(`Log: card ${open} ${reason}`)}
        trigger={<View style={{ height: 30, width: 100 }}><Text>SlowMention</Text></View>}
      >
        <Text>SlowCard</Text>
      </HoverCard>
      <HoverCard
        openDelay={0}
        closeDelay={0}
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onOpen={() => life.set("Life: card open")}
        onClose={() => life.set("Life: card closed")}
        trigger={<View style={{ height: 30, width: 100 }}><Text>LooksMention</Text></View>}
      >
        <Text style={{ height: 40 }}>LooksCard</Text>
      </HoverCard>
      <Text>{log()}</Text>
      <Text>{life()}</Text>
    </View>
  );
}

export default App;
