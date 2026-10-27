// A tiny ledger whose logic is Rust: the component `Gauge`, the module
// `Ledger` and the class `Account` all come from the app's crate
// (`native/`, nsh.json "rust"), imported by its specifier. Their types are
// generated from the Rust code into `.nsh/types/rust-exports/native.d.ts`.
import { type JSX, mount, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Account, Gauge, Ledger } from "rust-exports/native";

// Each object owns an instance kept in Rust.
const savings = new Account("Savings", 120);
const checking = Account.parse("Checking: 40");

/** A statement of a throwaway account: `using` frees it at the end of the block. */
function preview(): string {
  using draft = Account.parse("Draft: 10");
  draft.deposit(5);
  return draft.statement();
}

/** A press target with a label: `nsh/base`'s Button, given the app's look. */
function Button(props: { title: string; variant?: "primary" | "secondary" | "danger"; onPress: () => void }) {
  const colors = { primary: "#2563eb", secondary: "#e5e7eb", danger: "#dc2626" };
  const variant = () => props.variant ?? "primary";
  return (
    <BaseButton
      onPress={props.onPress}
      style={{ backgroundColor: colors[variant()], borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 }}
      activeStyle={{ opacity: 0.7 }}
    >
      <Text style={{ fontSize: 15, fontWeight: "600", color: variant() === "secondary" ? "#111827" : "#ffffff" }}>
        {props.title}
      </Text>
    </BaseButton>
  );
}

/** A titled group of lines. */
function Card(props: { title: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8, padding: 16, borderRadius: 12, backgroundColor: "#f3f4f6" }}>
      <Text style={{ fontSize: 13, fontWeight: "600", opacity: 0.6 }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

/** A line of text in the cards. */
function Line(props: { children: string; muted?: boolean }) {
  return <Text style={{ fontSize: 15, opacity: props.muted ? 0.6 : 1 }}>{props.children}</Text>;
}

function App() {
  // The module: a function returning its value at once, and two Promises.
  const copied = signal("Nothing copied yet");
  const rate = signal(0);

  // The class: a getter, a setter, methods, an async member, a callback.
  const name = signal(savings.name);
  const balance = signal(savings.balance);
  const toChecking = signal<number | null>(checking.balance);
  const heard = signal<number[]>([]);
  const status = signal(preview());
  savings.onChange((b) => {
    balance.set(b);
    heard.update((h) => [...h, b]);
  });
  const attempt = (f: () => string) => {
    try {
      status.set(f());
    } catch (e) {
      status.set((e as Error).message);
    }
  };

  // The component: controlled by `spent`, which its event updates.
  const spent = signal(25);
  const changes = signal(0);

  return (
    <View style={{ flex: 1, paddingTop: "env(safe-area-inset-top)", paddingRight: "env(safe-area-inset-right)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)" }}>
      <Scroll contentStyle={{ padding: 16, gap: 16 }}>
        <Card title="Ledger · a module">
          <Line>{`Formatted at once: ${Ledger.format(1234.5)}`}</Line>
          <Line muted>{copied()}</Line>
          <Line muted>{rate() ? `Rate: ${rate() * 100}%` : "Rate not fetched"}</Line>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              title="Copy statement"
              variant="secondary"
              onPress={async () => copied.set(`Copied ${await Ledger.copy(savings.statement())} characters`)}
            />
            <Button title="Fetch rate" variant="secondary" onPress={async () => rate.set(await Ledger.fetchRate())} />
          </View>
        </Card>

        <Card title="Account · a class">
          <Line>{`${name()}: ${Ledger.format(balance())}`}</Line>
          <Line>{`Checking: ${toChecking() === null ? "closed" : Ledger.format(toChecking()!)}`}</Line>
          <Line muted>{`Heard: ${heard().join(", ") || "nothing yet"}`}</Line>
          <Line muted>{status()}</Line>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button title="Deposit $25" onPress={() => attempt(() => `Deposited: ${Ledger.format(savings.deposit(25))}`)} />
            <Button
              title="Move $30"
              onPress={() =>
                attempt(() => {
                  const left = savings.transfer(checking, 30);
                  toChecking.set(checking.balance);
                  return `Moved $30, ${Ledger.format(left)} left`;
                })
              }
            />
            <Button
              title="Accrue"
              onPress={async () => status.set(`Accrued: ${Ledger.format(await savings.accrue(rate() || 0.01))}`)}
            />
            <Button
              title="Rename"
              variant="secondary"
              onPress={() => {
                savings.name = "Rainy day";
                name.set(savings.name);
              }}
            />
            <Button
              title="Close checking"
              variant="danger"
              onPress={() => {
                checking.dispose();
                toChecking.set(null);
                attempt(() => `Still open: ${checking.balance}`);
              }}
            />
          </View>
        </Card>

        <Card title="Gauge · a component">
          <Gauge
            value={spent()}
            step={25}
            label="Groceries"
            onChange={(v) => {
              spent.set(v);
              changes.update((n) => n + 1);
            }}
          >
            <Line muted>{`${Ledger.format(spent())} of $100.00`}</Line>
          </Gauge>
          <Line muted>{`Pressed ${changes()}×, onChange gave ${spent()}`}</Line>
        </Card>
      </Scroll>
    </View>
  );
}

mount(App);
