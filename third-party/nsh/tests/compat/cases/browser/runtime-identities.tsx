// Both Web execution hosts preserve app-realm values and nextTick's job order.
import { Text, View, cleanup, signal } from "nsh";
import { nextTick } from "process";
import { Buffer } from "buffer";

const unowned = () => {};
const unownedIdentity = (cleanup(unowned) as unknown) === unowned;

export default function RuntimeIdentities() {
  const ticks = signal(0);
  const owned = () => {};
  const ownedIdentity = (cleanup(owned) as unknown) === owned;
  let error = "none";
  try {
    nextTick(null as unknown as () => void);
  } catch (caught) {
    error = caught instanceof TypeError ? "TypeError" : "wrong realm";
  }
  return (
    <View style={{ padding: 24 }}>
      <Text>{`Buffer brand: ${Buffer.from("NSH") instanceof Uint8Array}`}</Text>
      <Text>{`Cleanup identity: ${unownedIdentity && ownedIdentity}`}</Text>
      <Text>{`Callback error: ${error}`}</Text>
      <Text>Ticks: {ticks()}</Text>
      <View testID="runtime-tick" onPress={() => nextTick((value) => ticks.set(value), ticks() + 1)}>
        <Text>Queue tick</Text>
      </View>
    </View>
  );
}
