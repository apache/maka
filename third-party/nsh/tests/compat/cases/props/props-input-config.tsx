// A case of the API's test suite (docs/dev/compatibility.md): the props of
// `<Input>` as the platform receives them on iOS (the scripts' default
// platform): the keyboard (`keyboardType`, `returnKeyType`,
// `autoCapitalize`, `autoCorrect`), `autoComplete` and iOS's
// `textContentType` for it, `maxLength`, `submitBehavior`, `autoFocus`,
// `caret`, `defaultValue` (the initial text, then the user's) and
// `value` (the text, controlled: what the app sets it to). Its script checks
// each.
import { Text, View, signal } from "nsh";
import { Input } from "nsh/base";

function App() {
  const name = signal("Ada");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Input
        testID="keys"
        keyboardType="email-address"
        returnKeyType="send"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Input testID="complete" autoComplete="one-time-code" />
      <Input testID="content-type" ios={{ textContentType: "emailAddress" }} />
      <Input testID="short" maxLength={4} />
      <Input testID="submit" submitBehavior="submit" />
      <Input testID="focused" autoFocus={true} caret={false} />
      <Input testID="initial" defaultValue="Hello" />
      <Input
        testID="controlled"
        value={name()}
        onChange={(text) => name.set(text.toUpperCase())}
      />
      <Text>{`Name: ${name()}`}</Text>
      <View testID="reset" onPress={() => name.set("Grace")}>
        <Text>Reset</Text>
      </View>
      <Input testID="plain" />
    </View>
  );
}

export default App;
