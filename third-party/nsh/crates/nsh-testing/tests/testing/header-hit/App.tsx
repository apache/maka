import { mount, Scroll, Text, View, signal } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

// A page whose `header` holds a button above a scroll view, with a large
// title and without.
const nav = createNavStack<string>(["large"]);
const pressed = signal("none");

mount(() => (
  <NavStack state={nav} class="flex-1">
    {(route) => (
      <NavPage
        title="T"
        headerLargeTitle={route === "large"}
        header={
          <View class="h-11">
            <View
              role="button"
              accessibilityLabel="Back"
              onPress={() => pressed.set("back")}
              class="h-10 w-10"
            />
          </View>
        }
      >
        <Scroll class="flex-1">
          <View class="p-5">
            <Text>Content</Text>
            <Text>{() => `Pressed: ${pressed()}`}</Text>
          </View>
        </Scroll>
      </NavPage>
    )}
  </NavStack>
));
