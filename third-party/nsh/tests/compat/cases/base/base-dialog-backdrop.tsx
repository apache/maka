// A case of the API's test suite (docs/dev/compatibility.md): the
// backdrop of `nsh/base`'s `Dialog`: a view behind the popup while the app
// styles one (`backdropStyle`, `backdropClass`), found by
// `backdropTestID`, whose presses are close attempts (`onCancel`, then
// `onOpenChange({ open: false, reason: "backdropPress" })`).
// Its script checks each.
import { Text, View, signal } from "nsh";
import { Dialog } from "nsh/base";

function App() {
  const styled = signal(true);
  const log = signal<string[]>([]);
  const note = (line: string) => log.set([...log(), line]);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Log: {log().join(", ")}</Text>
      <Dialog
        open={styled()}
        backdropTestID="shade"
        backdropStyle={{ backgroundColor: "#00000080" }}
        onCancel={() => note("styled cancel")}
        onOpenChange={({ open, reason }) => {
          note(`styled change ${open} ${reason}`);
          styled.set(open);
        }}
      >
        <Text>Styled dialog</Text>
      </Dialog>
      <Dialog backdropTestID="tinted" backdropClass="bg-[#ff0000]">
        <Text>Classed dialog</Text>
      </Dialog>
    </View>
  );
}

export default App;
