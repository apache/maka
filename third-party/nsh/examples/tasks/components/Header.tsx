// The page's header on the desktops and the web; iOS and Android show the system's, from the page's `title`.
import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { nav } from "../nav";

export function Header(props: { title: string }) {
  return (
    <View class="flex-row items-center gap-3 border-b border-border p-3">
      <If when={nav.routes().length > 1}>
        <Button onPress={() => nav.pop()} class="active:opacity-60">
          <Text class="text-primary">Back</Text>
        </Button>
      </If>
      <Text class="font-semibold text-foreground">{props.title}</Text>
    </View>
  );
}
