import { mount, signal, Text, View } from "nsh";
import { Button, Progress, Switch } from "nsh/base";
import { button, buttonText, desktop, Log, Panel, progressLook, progressSweep, Split, switchLook, ui, controlSize, listRow, plainRow, RowLabel, sectionSurface, type ProgressSweep } from "./palette";

// The parts come from the shared look (`progressLook`): the slider's sunk
// rail and its citrus fill, which glides to each new value (the whole track,
// slid back by what is left to do; the track clips it). An indeterminate bar
// is a third of the track sweeping from end to end and back, looped natively
// (`progressSweep`), and rests in the middle with reduced motion. The label
// row comes first (`column-reverse`: the children follow the track), its
// value tabular and at the trailing edge. The rows and the switch's row are
// the shared ones (`plainRow`, `listRow`). Buttons are as wide as their
// labels with a pointer.

function Transfer(props: { label: string; detail: string; value: number; indeterminate?: boolean; sweep: ProgressSweep; first?: boolean }) {
  return (
    // A row has no padding at its sides, so the bar's width is the track's:
    // the sweep crosses two thirds of it.
    <Progress
      value={props.value}
      indeterminate={props.indeterminate}
      onLayout={props.sweep.onLayout}
      style={{ ...plainRow({ first: props.first }), flexDirection: "column-reverse", alignItems: "stretch", gap: controlSize.padding }}
      {...progressLook(() => props.value, { indeterminate: () => props.indeterminate, sweep: props.sweep })}
    >
      <View class="flex-row items-center gap-3">
        <RowLabel label={props.label} detail={props.detail} />
        <Text style={{ fontSize: controlSize.label, color: ui().muted, fontVariant: ["tabular-nums"], textAlign: "right" }}>
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
      {...button("secondary", { disabled: () => !!props.disabled, style: desktop ? {} : { flex: 1 } })}
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
  // The sweep of the indeterminate bars, one for all three.
  const sweep = progressSweep();
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
                onChange={({ checked }) => {
                  unknown.set(checked);
                  if (checked) stop();
                  log(checked ? "Size unknown: indeterminate" : "Size known: value " + sent());
                }}
                {...listRow({ first: true, style: { flexDirection: "row-reverse" } })}
                {...switchLook(() => unknown())}
              >
                <RowLabel label="Size unknown" />
              </Switch>
            </Panel>
            <Log title="events" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={sectionSurface({ padded: true })}>
          <Transfer
            first
            label="Sending 24 photos"
            detail={unknown() ? "Counting what to send" : sent() >= 100 ? "Sent" : `${Math.round((sent() / 100) * 24)} of 24`}
            value={sent()}
            indeterminate={unknown()}
            sweep={sweep}
          />
          <Transfer label="Preparing the backup" detail="Its size is not known yet" value={0} indeterminate sweep={sweep} />
          <Transfer label="Library" detail="212 GB of 256 GB" value={83} sweep={sweep} />
        </View>
      </Split>
    </View>
  );
}

mount(App);
