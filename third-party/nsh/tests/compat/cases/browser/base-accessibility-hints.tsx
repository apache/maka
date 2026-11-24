import { Text, View, signal } from "nsh";
import { Button, Checkbox, Link, MenuButton, Switch } from "nsh/base";

export default function App() {
  const hint = signal<string | null | undefined>("Removes the draft");
  return (
    <View>
      <Button testID="button" accessibilityHint={hint()} onPress={() => hint.set("Restores the draft")}>
        <Text>Draft action</Text>
      </Button>
      <Link testID="link" href="/drafts" accessibilityHint="Opens saved drafts"><Text>Drafts</Text></Link>
      <Switch testID="switch" accessibilityHint="Mutes notifications"><Text>Mute</Text></Switch>
      <Checkbox testID="checkbox" accessibilityHint="Keeps a local copy"><Text>Save a copy</Text></Checkbox>
      <MenuButton testID="menu" accessibilityHint="Shows draft actions"><Text>Actions</Text></MenuButton>
      <Button testID="clear-null" onPress={() => hint.set(null)}><Text>Clear with null</Text></Button>
      <Button testID="clear-undefined" onPress={() => hint.set(undefined)}><Text>Clear with undefined</Text></Button>
    </View>
  );
}
