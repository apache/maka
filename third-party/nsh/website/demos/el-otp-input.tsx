import { Clipboard, cleanup, mount, signal, Text, View } from "nsh";
import { Button, OtpInput, Switch } from "nsh/base";
import { button, buttonText, desktop, Log, Panel, Split, switchLook, ui, RowLabel, sectionSurface, listRow, controlSize, otpCellLook } from "./palette";

// The cells are the shared one-time code look (`otpCellLook`): wells a
// digit (a bullet too) lifts out of, the cell that takes the next digit
// edged in the accent while the code has the focus (the fields' focus
// edge), its caret blinking there (steady with reduced motion: the input's
// own), the verdict's tone over all of them, each change fading. Cells are
// 44 points high on a touch screen, 36 wide with a pointer; the switches'
// rows and the buttons are the shared ones.
const CODE = "246810";

function Option(props: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <Switch
      checked={props.checked}
      onChange={({ checked }) => props.onChange(checked)}
      {...listRow({ first: true, style: { flexDirection: "row-reverse" } })}
      {...switchLook(() => props.checked)}
    >
      <RowLabel label={props.label} />
    </Switch>
  );
}

function Action(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Button onPress={props.onPress} disabled={props.disabled} {...button("secondary", { disabled: () => !!props.disabled, style: desktop ? {} : { flex: 1 } })}>
      <Text style={buttonText()}>{props.label}</Text>
    </Button>
  );
}

function App() {
  const code = signal("");
  const masked = signal(false);
  const disabled = signal(false);
  const status = signal<"typing" | "checking" | "right" | "wrong">("typing");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 6));
  // Checking the code takes a moment, as a server's answer does.
  let check: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(check));
  const verify = (value: string) => {
    status.set("checking");
    clearTimeout(check);
    check = setTimeout(() => status.set(value === CODE ? "right" : "wrong"), 600);
  };
  const message = () =>
    ({
      typing: { text: `${code().length} of 6 digits`, color: ui().muted },
      checking: { text: "Checking…", color: ui().muted },
      right: { text: "Verified", color: ui().up },
      wrong: { text: "That code is not right", color: ui().down },
    })[status()];

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>otp input</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click the code and type it, or paste it; Tab reaches it too" : "Tap the code to type it, or paste it"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value · masked · disabled">
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                {code() ? `value “${masked() ? "•".repeat(code().length) : code()}”` : "value “” (empty)"}
              </Text>
              <Option
                label="Masked"
                checked={masked()}
                onChange={(next) => {
                  masked.set(next);
                  log(next ? "masked: bullets, a secure field" : "masked off");
                }}
              />
              <Option
                label="Disabled"
                checked={disabled()}
                onChange={(next) => {
                  disabled.set(next);
                  log(next ? "disabled: no focus" : "enabled");
                }}
              />
            </Panel>
            <Log title="onChange · onComplete · onFocus · onBlur" lines={events()} minHeight={120} />
          </>
        }
      >
        <View style={{ ...sectionSurface(), padding: desktop ? 20 : 16, gap: 16, alignItems: "center" }}>
          <View style={{ gap: 4, alignItems: "center" }}>
            <Text style={{ fontSize: controlSize.label, fontWeight: "600", color: ui().text }}>Enter the code</Text>
            <Text style={{ fontSize: controlSize.detail, color: ui().muted }}>{`We sent it to •••• 4821 (it is ${CODE})`}</Text>
          </View>
          <OtpInput
            length={6}
            groups={2}
            value={code()}
            masked={masked()}
            disabled={disabled()}
            onChange={({ value: next }) => {
              code.set(next);
              status.set("typing");
              log(`onChange “${next}”`);
            }}
            onComplete={({ value }) => {
              log(`onComplete “${value}”`);
              verify(value);
            }}
            onFocus={() => log("onFocus")}
            onBlur={() => log("onBlur")}
            accessibilityLabel="Verification code, 6 digits"
            class="flex-row items-center gap-3"
            groupClass="flex-row gap-1.5"
            {...otpCellLook({ tone: () => (status() === "wrong" ? "danger" : status() === "right" ? "up" : undefined) })}
          />
          <Text style={{ fontSize: controlSize.detail, color: message().color }}>{message().text}</Text>
          <View class={desktop ? "flex-row gap-2" : "flex-row gap-2 self-stretch"}>
            <Action
              label="Copy the code"
              onPress={() => {
                Clipboard.writeText(CODE);
                log("copied: paste it into the code");
              }}
            />
            <Action
              label="Clear"
              disabled={code() === ""}
              onPress={() => {
                code.set("");
                status.set("typing");
                log("value set to “”");
              }}
            />
          </View>
        </View>
      </Split>
    </View>
  );
}

mount(App);
