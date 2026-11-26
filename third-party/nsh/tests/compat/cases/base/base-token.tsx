// A case of the API's test suite (docs/dev/compatibility.md): the design
// tokens of the app's theme (nsh.json `"theme"`, shadcn's `cssVars` over
// shadcn's `neutral`). `token()` reads one in the appearance shown (a
// color as `#rrggbbaa`, a number); a class names one as Tailwind names a
// theme variable (`bg-up`, `bg-primary/50`, `text-up/50`,
// `rounded-(--radius-card)`); a number is a length, and a factor to the
// scale utilities (`active:scale-(--press-scale)`, `ring-(length:--x)`).
// Its script checks each.
import { Text, View, token } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`token up ${token("up")}`}</Text>
      <Text>{`token primary ${token("primary")}`}</Text>
      <Text>{`token radius-card ${token("radius-card")}`}</Text>
      <View testID="up" class="h-4 bg-up rounded-(--radius-card)" />
      <View testID="primary" class="h-4 bg-primary/50" />
      <Text testID="faded" class="text-up/50">A token's color at half its alpha</Text>
      <View testID="token-scale" class="h-4 scale-(--press-scale)" />
      <View testID="token-press" class="h-4 active:scale-(--press-scale)" onPress={() => {}} />
      <View testID="token-ring" class="h-4 ring-(length:--ring-width) ring-up" />
      <View testID="token-ring-offset" class="h-4 ring-2 ring-up ring-offset-(length:--ring-gap)" />
      <View testID="token-inset-ring" class="h-4 inset-ring-(length:--ring-width) inset-ring-up" />
    </View>
  );
}

export default App;
