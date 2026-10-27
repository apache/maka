// Navigation: a stack of pages with header options, pushed and popped; in a
// wide window the inbox and the open message side by side (master–detail).
import { type JSX, mount, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { button, buttonText, focusRing, hoverFill, size, tint, ui, wide } from "./palette";

function Button(props: { title: string; variant?: "primary" | "secondary"; onPress: () => void }) {
  const kind = () => (props.variant !== "secondary" ? "primary" : "secondary");
  return (
    <View role="button" onPress={props.onPress} {...button(kind())}>
      <Text style={buttonText(kind())}>{props.title}</Text>
    </View>
  );
}

type Route = { name: "home" } | { name: "detail"; id: number };

const nav = createNavStack<Route>([{ name: "home" }]);

// The page's own header where NSH draws none (the web, the desktops); iOS and
// Android show the system's, from `title` and `headerRight`.
function Header(props: { title: string; right?: JSX.Element }) {
  return (
    <View style={{ backgroundColor: ui().page, borderBottomWidth: 1, borderBottomColor: ui().line }} class="h-12 flex-row items-center px-2">
      <View class="w-20 flex-row">
        <If when={nav.routes().length > 1}>
          <View role="button" accessibilityLabel="Back" onPress={() => nav.pop()} hoverStyle={hoverFill()} focusStyle={focusRing()} class="rounded-md px-2 py-1 active:opacity-60">
            <Text style={{ fontSize: 17, color: ui().accent }}>‹ Back</Text>
          </View>
        </If>
      </View>
      <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "600", color: ui().text }} class="flex-1 text-center">
        {props.title}
      </Text>
      <View class="w-20 flex-row justify-end px-2">{props.right}</View>
    </View>
  );
}

// A page's content: a column as wide as a phone, centered in a wider window.
function Body(props: { children: JSX.Element }) {
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 16, paddingTop: 24 }}>
      <View style={{ width: "100%", maxWidth: 480, alignSelf: "center", gap: 12 }}>{props.children}</View>
    </View>
  );
}

function Home() {
  const opened = signal(0);
  return (
    <NavPage title="Inbox" header={<Header title="Inbox" />}>
      <Body>
        <Text style={{ color: ui().muted }}>{`Opened ${opened()} messages`}</Text>
        <Button
          title="Open message 1"
          onPress={() => {
            opened.set(opened() + 1);
            nav.push({ name: "detail", id: 1 });
          }}
        />
        <Button title="Open message 2" variant="secondary" onPress={() => nav.push({ name: "detail", id: 2 })} />
      </Body>
    </NavPage>
  );
}

function Detail(props: { id: number }) {
  const starred = signal(false);
  const star = () => (
    <Text onPress={() => starred.set(!starred())} style={{ fontSize: 17, color: ui().accent }} hoverStyle={hoverFill()} focusStyle={focusRing()} activeStyle={{ opacity: 0.7 }}>
      {starred() ? "★" : "☆"}
    </Text>
  );
  return (
    <NavPage title={`Message ${props.id}`} headerRight={star()} header={<Header title={`Message ${props.id}`} right={star()} />}>
      <Body>
        <Text style={{ color: ui().text }}>{`The body of message ${props.id}.`}</Text>
        <Button title="Next message" onPress={() => nav.push({ name: "detail", id: props.id + 1 })} />
        <Button title="Back to the inbox" variant="secondary" onPress={() => nav.popToRoot()} />
      </Body>
    </NavPage>
  );
}

const messages = [1, 2, 3, 4, 5, 6];

/** A wide window: the inbox on the start side, the selected message beside it. */
function Inbox() {
  const selected = signal(1);
  const starred = signal<number[]>([]);
  const star = (id: number) => (
    <Text
      onPress={() => starred.set(starred().includes(id) ? starred().filter((s) => s !== id) : [...starred(), id])}
      style={{ fontSize: 17, color: ui().accent }}
      hoverStyle={hoverFill()}
      focusStyle={focusRing()}
      activeStyle={{ opacity: 0.7 }}
    >
      {starred().includes(id) ? "★" : "☆"}
    </Text>
  );
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: ui().page }}>
      <View style={{ width: 320, borderRightWidth: 1, borderRightColor: ui().line }}>
        <Header title="Inbox" />
        <View style={{ padding: 8, gap: 2 }}>
          <Each of={messages}>
            {(id) => (
              <View
                role="button"
                onPress={() => selected.set(id())}
                hoverStyle={selected() === id() ? undefined : hoverFill()}
                style={{
                  height: size.row + 12,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  justifyContent: "center",
                  gap: 2,
                  backgroundColor: selected() === id() ? tint(ui().accent, 0.14) : "transparent",
                }}
                focusStyle={focusRing()}
                activeStyle={{ opacity: 0.7 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ flex: 1, fontSize: size.label, fontWeight: "600", color: ui().text }}>{`Message ${id()}`}</Text>
                  <Text style={{ fontSize: 12, color: ui().accent }}>{starred().includes(id()) ? "★" : ""}</Text>
                </View>
                <Text numberOfLines={1} style={{ fontSize: 12, color: ui().muted }}>{`The body of message ${id()}.`}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Header title={`Message ${selected()}`} right={star(selected())} />
        <View style={{ padding: 24, gap: 12 }}>
          <Text style={{ color: ui().text }}>{`The body of message ${selected()}.`}</Text>
          <Text style={{ fontSize: 13, color: ui().muted }}>Click a message on the left; on a phone it opens as a page of a NavStack.</Text>
          <Button title="Next message" onPress={() => selected.set(selected() === messages.length ? 1 : selected() + 1)} />
        </View>
      </View>
    </View>
  );
}

function App() {
  return (
    <>
      {() =>
        wide() ? (
          <Inbox />
        ) : (
          <NavStack state={nav} style={{ flex: 1 }}>
            {(route) => (route.name === "home" ? <Home /> : <Detail id={route.id} />)}
          </NavStack>
        )
      }
    </>
  );
}

mount(App);
