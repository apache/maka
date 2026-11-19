// A case of the API's test suite (docs/dev/compatibility.md): `Tooltip`'s
// fixed grace period on a desktop. While a tooltip the pointer showed is
// up, or within 300 ms of the pointer leaving its trigger, a trigger the
// pointer comes to shows its tooltip at once, without its `delay` (a
// minute here, longer than a script waits); past that, a trigger waits for
// its delay. Its script checks the first and the last: a script's steps
// take longer than 300 ms apart.
import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 300, paddingLeft: 20, gap: 8 }}>
      <View style={{ height: 30, width: 100 }} tooltip={<Tooltip delay={500}><Text>FirstTip</Text></Tooltip>}>
        <Text>FirstTrigger</Text>
      </View>
      <View
        style={{ height: 30, width: 100 }}
        tooltip={
          <Tooltip delay={60000}>
            <Text>GraceTip</Text>
          </Tooltip>
        }
      >
        <Text>GraceTrigger</Text>
      </View>
      <View style={{ height: 30, width: 100 }} tooltip={<Tooltip delay={60000}><Text>WaitTip</Text></Tooltip>}>
        <Text>WaitTrigger</Text>
      </View>
    </View>
  );
}

export default App;
