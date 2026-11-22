// Structural classes follow element order through keyed row updates.
import { Text, View, signal } from "nsh";

export default function App() {
  const items = signal([1, 2, 3]);
  return (
    <View>
      <Text>Sibling classes</Text>
      <View onPress={() => items.set([3, 1, 2])}><Text>Reorder siblings</Text></View>
      <View onPress={() => items.set([...items(), 4])}><Text>Append sibling</Text></View>
      <View onPress={() => items.set([2])}><Text>Keep one sibling</Text></View>
      <View>
        <Each of={items()}>
          {id => (
            <View testID={`sibling-${id()}`} class="w-[10px] h-[10px] bg-[#ff0000] first:bg-[#00ff00] last:bg-[#0000ff] odd:h-[20px] even:h-[30px] only:p-[2px]">
              <View testID={`sibling-inner-${id()}`} style={{ width: 1, height: 1 }} />
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}
