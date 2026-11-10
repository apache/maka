// Two tabs with a stack each, the one not selected `display: none`: going
// back acts on the stack that shows (`nsh_core::navigation::shown_in_layout`).
import { Text, View, mount, signal } from "nsh";
import { Button, NavPage, NavStack, createNavStack } from "nsh/base";

const a = createNavStack<string>(["a0"]);
const b = createNavStack<string>(["b0"]);
const tab = signal<"a" | "b">("a");

mount(() => (
  <View style={{ flex: 1 }}>
    <View style={{ flexDirection: "row" }}>
      <Button onPress={() => a.push(`a${a.routes().length}`)}><Text>Push A</Text></Button>
      <Button onPress={() => b.push(`b${b.routes().length}`)}><Text>Push B</Text></Button>
      <Button onPress={() => tab.set(tab() === "a" ? "b" : "a")}><Text>Switch</Text></Button>
      <Text>{`A: ${a.routes().join(">")} B: ${b.routes().join(">")}`}</Text>
    </View>
    <View class={tab() === "a" ? "flex-1" : "hidden"}>
      <NavStack state={a} style={{ flex: 1 }}>{(route) => <NavPage><Text>{route}</Text></NavPage>}</NavStack>
    </View>
    <View class={tab() === "b" ? "flex-1" : "hidden"}>
      <NavStack state={b} style={{ flex: 1 }}>{(route) => <NavPage><Text>{route}</Text></NavPage>}</NavStack>
    </View>
  </View>
));
