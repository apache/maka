import { type MacOsBackdrop, Text, View, signal } from "nsh";

export default function MaterialComposition() {
  const backdrop = signal<MacOsBackdrop | undefined>({
    material: "hudWindow",
    blending: "behindWindow",
    state: "followsWindowActiveState",
  });
  const tint = signal<string | undefined>("#ff000080");
  const wide = signal(false);
  return (
    <View style={{ paddingTop: 64 }}>
      <Text>Material composition</Text>
      <View
        testID="material-surface"
        macos={{ backdrop: backdrop() }}
        style={{
          width: wide() ? 160 : 120,
          height: 32,
          backdropFilter: "blur(10px)",
          glassEffect: "regular",
          glassTintColor: tint(),
          mixBlendMode: "color",
        }}
      />
      <View testID="material-restyle" onPress={() => wide.set(true)}><Text>Restyle surface</Text></View>
      <View testID="material-change" onPress={() => backdrop.set({ material: "sidebar", state: "inactive" })}>
        <Text>Change material</Text>
      </View>
      <View testID="material-clear" onPress={() => backdrop.set(undefined)}><Text>Clear material</Text></View>
      <View testID="tint-change" onPress={() => tint.set("#00ff0040")}><Text>Change tint</Text></View>
      <View testID="tint-clear" onPress={() => tint.set(undefined)}><Text>Clear tint</Text></View>
    </View>
  );
}
