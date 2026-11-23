import {mount, signal, Scroll, Text, View} from "nsh";
function App() {
  const longs = signal(0);
  return <View class="flex-1 p-8 gap-4">
    <Scroll class="h-40">
      <View testID="source" class="h-24" delayLongPress={60}
        onLongPress={() => longs.set(longs() + 1)} onPress={() => {}}>
        <Text>Short long-press delay</Text>
      </View>
      <View class="h-96" />
    </Scroll>
    <Text>{`longs=${longs()}`}</Text>
  </View>;
}
mount(App);
