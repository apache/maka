// A case of the API's test suite (docs/dev/compatibility.md): the design
// tokens of the app's theme (nsh.json `"theme"`, shadcn's `cssVars` over
// shadcn's `neutral`). `token()` reads one in the appearance shown (a
// color as `#rrggbbaa`, a number); a class names one as Tailwind names a
// theme variable (`bg-up`, `bg-primary/50`, `text-up/50`,
// `rounded-(--radius-card)`). Its script checks each.
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
    </View>
  );
}

export default App;
