// A case of the API's test suite (docs/dev/compatibility.md): `HoverCard` of
// `nsh/base` on a phone, where a press on its trigger opens and closes it
// and a press outside or Escape / back closes it: controlled and not
// (`defaultOpen`), its side, alignment, gap and margin, its popup styled by
// the app, every change reported with its reason, its lifecycle (`onOpen`,
// `onClose`) and the side it went on (`onPosition`). Its script checks each.
import { Text, View, signal } from "nsh";
import { HoverCard } from "nsh/base";

function App() {
  const log = signal("Log: none");
  const life = signal("Life: none");
  const side = signal("Side: none");
  const open = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 300, paddingLeft: 20, paddingRight: 20, gap: 8 }}>
      <HoverCard
        open={open()}
        onOpenChange={({ open: next, reason }) => {
          open.set(next);
          log.set(`Log: card ${next} ${reason}`);
        }}
        onOpen={() => life.set("Life: card open")}
        onClose={() => life.set("Life: card closed")}
        onPosition={({ placement }) => side.set(`Side: ${placement}`)}
        placement="top"
        align="start"
        offset={6}
        margin={30}
        popupClass="bg-[#123456]"
        popupStyle={{ width: 120, height: 40 }}
        trigger={<View testID="mention" style={{ height: 30, width: 100 }}><Text>@ada</Text></View>}
      >
        <Text>AdaCard</Text>
      </HoverCard>
      <HoverCard defaultOpen trigger={<View style={{ height: 30, width: 100 }}><Text>OwnTrigger</Text></View>}>
        <Text>OwnCard</Text>
      </HoverCard>
      <View onPress={() => {}} style={{ height: 30 }}><Text>Elsewhere</Text></View>
      <Text>{log()}</Text>
      <Text>{life()}</Text>
      <Text>{side()}</Text>
    </View>
  );
}

export default App;
