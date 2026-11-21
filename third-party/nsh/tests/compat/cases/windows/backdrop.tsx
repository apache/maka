import { Text, View, type WindowsBackdrop, signal } from "nsh";

export default function Backdrop() {
  const backdrop: WindowsBackdrop = { material: "blur" };
  const shown = signal(true);
  return (
    <View style={{ paddingTop: 64 }}>
      <Text>Blur backdrop</Text>
      <View
        testID="backdrop-surface"
        windows={shown() ? { backdrop } : {}}
        macos={{ backdrop: { material: "hudWindow" } }}
        style={{ width: 120, height: 32, borderRadius: 12, backgroundColor: "#ffffff66" }}
      />
      <View testID="backdrop-clear" onPress={() => shown.set(false)}><Text>Clear backdrop</Text></View>
      <View testID="backdrop-set" onPress={() => shown.set(true)}><Text>Set backdrop</Text></View>
    </View>
  );
}
