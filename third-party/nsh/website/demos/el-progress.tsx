import { cleanup, mount, signal, Text, View } from "nsh";
import { reduceMotion } from "nsh";
import { Button, Progress, Switch } from "nsh/base";
import { button, buttonText, desktop, focusRing, hoverFill, Log, Panel, size, Split, ui } from "./palette";

// The parts: geometry and motion in classes, colors from the palette. The
// label row comes first (`flex-col-reverse`: the children follow the track),
// its value tabular and at the trailing edge. An indeterminate indicator is a
// third of the track that sweeps from end to end (the app flips its
// translation, a transition moves it), and rests in the middle with reduced
// motion; the pointer's hover and the keyboard's focus ring come from the
// palette. Buttons are as wide as their labels with a pointer.
const pad = desktop ? "px-3 py-3" : "px-4 py-4";
const track = "h-1.5 overflow-hidden rounded-full";
const SWEEP = 800;
const indicator = (indeterminate: boolean, end: boolean) =>
  !indeterminate
    ? "h-full rounded-full"
    : reduceMotion()
      ? "h-full w-1/3 rounded-full translate-x-full"
      : `h-full w-1/3 rounded-full transition-transform duration-700 ease-in-out ${end ? "translate-x-[200%]" : "translate-x-0"}`;

function Transfer(props: { label: string; detail: string; value: number; indeterminate?: boolean; end: boolean }) {
  return (
    <Progress
      value={props.value}
      indeterminate={props.indeterminate}
      class={`flex-col-reverse gap-2 ${pad}`}
      trackClass={track}
      trackStyle={ui().inset}
      indicatorClass={indicator(!!props.indeterminate, props.end)}
      indicatorStyle={{ backgroundColor: ui().accent }}
    >
      <View class="flex-row items-baseline gap-3">
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
          <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
        </View>
        <Text style={{ fontSize: size.label, color: ui().muted, fontVariant: ["tabular-nums"], textAlign: "right" }}>
          {props.indeterminate ? "—" : `${Math.round(props.value)}%`}
        </Text>
      </View>
    </Progress>
  );
}

function Action(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      {...button("secondary", { style: desktop ? {} : { flex: 1 } })}
    >
      <Text style={buttonText()}>{props.label}</Text>
    </Button>
  );
}

function App() {
  const sent = signal(35);
  const running = signal(false);
  const unknown = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  // The sweep of the indeterminate bars: still with reduced motion.
  const end = signal(false);
  const sweep = setInterval(() => {
    if (!reduceMotion()) end.set(!end());
  }, SWEEP);
  cleanup(() => clearInterval(sweep));
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    running.set(false);
  };
  const start = () => {
    if (sent() >= 100) sent.set(0);
    running.set(true);
    log(`Start at ${sent()}%`);
    timer = setInterval(() => {
      sent.set(Math.min(100, sent() + 5));
      if (sent() >= 100) {
        stop();
        log("Done: value 100");
      }
    }, 200);
  };
  const line = () => <View style={{ height: 1, marginLeft: desktop ? 12 : 16, backgroundColor: ui().line }} />;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>progress</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click Start, or Tab to it and press Space" : "Tap Start to send the photos"}</Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value · indeterminate">
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                {unknown() ? "indeterminate (no value for screen readers)" : `value ${sent()} of 100`}
              </Text>
              <View class={desktop ? "flex-row self-start gap-2" : "flex-row gap-2"}>
                <Action label={running() ? "Pause" : sent() >= 100 ? "Again" : "Start"} disabled={unknown()} onPress={() => (running() ? (stop(), log(`Pause at ${sent()}%`)) : start())} />
                <Action
                  label="Reset"
                  disabled={sent() === 0}
                  onPress={() => {
                    stop();
                    sent.set(0);
                    log("Reset: value 0");
                  }}
                />
              </View>
              <Switch
                checked={unknown()}
                onChange={(next) => {
                  unknown.set(next);
                  if (next) stop();
                  log(next ? "Size unknown: indeterminate" : "Size known: value " + sent());
                }}
                class={`-mx-2 flex-row-reverse items-center justify-between gap-3 rounded-lg px-2 ${desktop ? "py-1" : "py-2"} active:opacity-70`}
                hoverStyle={hoverFill()}
                focusStyle={focusRing()}
                trackClass={`${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`}
                trackStyle={unknown() ? ui().accentFill : ui().inset}
                thumbClass={desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5"}
                thumbStyle={unknown() ? { backgroundColor: ui().onAccent } : ui().raised}
              >
                <Text style={{ flex: 1, fontSize: size.label, color: ui().text }}>Size unknown</Text>
              </Switch>
            </Panel>
            <Log title="events" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, overflow: "hidden" }}>
          <Transfer
            label="Sending 24 photos"
            detail={unknown() ? "Counting what to send" : sent() >= 100 ? "Sent" : `${Math.round((sent() / 100) * 24)} of 24`}
            value={sent()}
            indeterminate={unknown()}
            end={end()}
          />
          {line()}
          <Transfer label="Preparing the backup" detail="Its size is not known yet" value={0} indeterminate end={end()} />
          {line()}
          <Transfer label="Library" detail="212 GB of 256 GB" value={83} end={end()} />
        </View>
      </Split>
    </View>
  );
}

mount(App);
