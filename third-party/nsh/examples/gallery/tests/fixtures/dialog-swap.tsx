import { mount, platform, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Button, Dialog } from "nsh/base";

type Shown = "none" | "first" | "wrapped" | "earlier" | "later";

// Page sheet dialogs, one replacing another in a single press: "earlier"
// is written before "first", "later" after it, and "wrapped" is closed by
// removing the view it is in, not the dialog itself. "top" opens over
// "base" and closes right after it; "inner" opens in "outer" and closes
// right before it.
function App() {
  const shown = signal<Shown>("none");
  const count = signal(0);
  const closed = signal<string[]>([]);
  const base = signal(false);
  const top = signal(false);
  const outer = signal(false);
  const inner = signal(false);
  const close = (name: string) => closed.update((all) => [...all, name]);
  const sheet = (name: Shown, title: string, next: { label: string; to: Shown }[]) => (
    <Dialog
      open={shown() === name}
      presentation="pageSheet"
      onOpenChange={({ open }) => {
        if (!open && shown() === name) shown.set("none");
      }}
      onClose={() => closed.update((all) => [...all, name])}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1, padding: 24, gap: 12 }}>
        <Text>{title}</Text>
        {next.map(({ label, to }) => (
          <Button onPress={() => shown.set(to)}>
            <Text>{label}</Text>
          </Button>
        ))}
        <Button onPress={() => count.update((n) => n + 1)}>
          <Text>{`Count in ${title}`}</Text>
        </Button>
      </View>
    </Dialog>
  );
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24, gap: 12 }}>
      <Text>{`shown: ${shown()}`}</Text>
      <Text>{`count: ${count()}`}</Text>
      <Text>{`closed: ${closed().join(", ")}`}</Text>
      <Text>{closed().includes("top") ? "top: closed" : "top: not closed"}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
      <Button onPress={() => shown.set("first")}>
        <Text>Open first</Text>
      </Button>
      <Button onPress={() => shown.set("wrapped")}>
        <Text>Open wrapped</Text>
      </Button>
      <Button onPress={() => base.set(true)}>
        <Text>Open base</Text>
      </Button>
      <Button onPress={() => outer.set(true)}>
        <Text>Open outer</Text>
      </Button>
      <Dialog open={base()} presentation="pageSheet" onClose={() => close("base")} style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: 24, gap: 12 }}>
          <Text>Base sheet</Text>
          <Button onPress={() => top.set(true)}>
            <Text>Open top</Text>
          </Button>
        </View>
      </Dialog>
      <Dialog open={top()} presentation="pageSheet" onClose={() => close("top")} style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: 24, gap: 12 }}>
          <Text>Top sheet</Text>
          {/* The base goes and takes the top along; the top closes while that runs. */}
          <Button
            onPress={() => {
              base.set(false);
              setTimeout(() => top.set(false), 100);
            }}
          >
            <Text>Close base, then top</Text>
          </Button>
        </View>
      </Dialog>
      <Dialog open={outer()} presentation="pageSheet" onClose={() => close("outer")} style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: 24, gap: 12 }}>
          <Text>Outer sheet</Text>
          <Button onPress={() => inner.set(true)}>
            <Text>Open inner</Text>
          </Button>
          <Dialog open={inner()} presentation="pageSheet" onClose={() => close("inner")} style={{ flex: 1 }}>
            <View style={{ flex: 1, padding: 24, gap: 12 }}>
              <Text>Inner sheet</Text>
              {/* The outer closes while the inner's dismissal runs, then another opens. */}
              <Button
                onPress={() => {
                  inner.set(false);
                  setTimeout(() => outer.set(false), 100);
                  setTimeout(() => shown.set("later"), 200);
                }}
              >
                <Text>Close inner, then outer, then open later</Text>
              </Button>
            </View>
          </Dialog>
        </View>
      </Dialog>
      {sheet("earlier", "Earlier sheet", [])}
      {sheet("first", "First sheet", [
        { label: "Replace with earlier", to: "earlier" },
        { label: "Replace with later", to: "later" },
      ])}
      <If when={shown() === "wrapped"}>
        <View>
          {/* Open while the view is there: closed with it. */}
          <Dialog open presentation="pageSheet" onClose={() => closed.update((all) => [...all, "wrapped"])} style={{ flex: 1 }}>
            <View style={{ flex: 1, padding: 24, gap: 12 }}>
              <Text>Wrapped sheet</Text>
              <Button onPress={() => shown.set("later")}>
                <Text>Replace wrapped with later</Text>
              </Button>
            </View>
          </Dialog>
        </View>
      </If>
      {sheet("later", "Later sheet", [])}
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
