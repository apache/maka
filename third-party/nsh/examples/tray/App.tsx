// A tray app: nsh.json's `window.defaultVisible: false` starts it with only
// its icon in the tray (the menu bar on macOS, the notification area on
// Windows, a StatusNotifierItem on Linux); the main window is made and the
// app runs in it, unseen. A click on the icon shows the window. Closing the
// window hides it (nsh.json's `closeOnPress: false`, then `hide()` when the
// app hears `closePress`), so the app keeps running in the tray; the tray's
// menu quits it. The window is a focus timer, whose time left the icon's
// tooltip shows, and which comes forward when a session ends.
import { cleanup, computed, effect, mount, platform, signal, Text, View } from "nsh";
import { Button, Progress } from "nsh/base";
import { currentWindow, Tray } from "nsh/desktop";
import icon from "./tray.svg";

/** The sessions' lengths, in minutes. */
const LENGTHS = [15, 25, 50];

/** `seconds` as minutes and seconds: `24:59`. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function App() {
  const win = currentWindow();
  const length = signal(25 * 60);
  const left = signal(25 * 60);
  const running = signal(false);

  // A tick a second while the timer runs.
  let ticks: ReturnType<typeof setInterval> | undefined;
  const pause = () => {
    clearInterval(ticks);
    running.set(false);
  };
  const start = () => {
    if (left() === 0) left.set(length());
    running.set(true);
    ticks = setInterval(() => {
      left.set(left() - 1);
      if (left() === 0) {
        pause();
        // The session ended: the window comes forward to say so.
        win.focus();
      }
    }, 1000);
  };
  const reset = () => {
    pause();
    left.set(length());
  };
  const choose = (minutes: number) => {
    length.set(minutes * 60);
    reset();
  };
  cleanup(() => clearInterval(ticks));

  // The close button hides the window: the app stays in the tray.
  win.on("closePress", () => win.hide());

  // The icon follows the app: its tooltip says what is left (a change a
  // minute), its menu starts or pauses the timer and shows or hides the
  // window.
  const tooltip = computed(() => (running() ? `Focus: ${Math.ceil(left() / 60)} min left` : "Focus"));
  const shown = computed(() => win.state()?.visible ?? false);
  effect(() => {
    Tray.set({
      icon,
      tooltip: tooltip(),
      onClick: () => win.focus(),
      menu: [
        { label: shown() ? "Hide Focus" : "Show Focus", onSelect: () => (shown() ? win.hide() : win.focus()) },
        { label: running() ? "Pause" : "Start", onSelect: () => (running() ? pause() : start()) },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  });
  cleanup(() => Tray.set(null));

  const status = () =>
    running()
      ? "Focusing"
      : left() === 0
        ? "Session done"
        : left() < length()
          ? "Paused"
          : `${length() / 60}-minute session`;
  return (
    <View class="flex-1 gap-5 bg-background px-6 pb-6 pt-5">
      <View class="items-center gap-1">
        <Text class="text-5xl font-semibold tabular-nums text-foreground">{clock(left())}</Text>
        <Text class="text-xs font-medium text-muted-foreground" classList={{ "text-foreground": running() }}>
          {status()}
        </Text>
      </View>
      <Progress
        value={(1 - left() / length()) * 100}
        accessibilityLabel="Session"
        trackClass="h-1.5 overflow-hidden rounded-full bg-muted"
        indicatorClass="h-full rounded-full bg-primary"
      />
      <View class="flex-row gap-2">
        <Each of={LENGTHS}>
          {(minutes) => (
            <Button
              onPress={() => choose(minutes())}
              class="flex-1 items-center rounded-(--radius) border border-border py-1.5 active:bg-muted"
              classList={{ "border-primary bg-muted": length() === minutes() * 60 }}
            >
              <Text class="text-xs text-foreground">{`${minutes()} min`}</Text>
            </Button>
          )}
        </Each>
      </View>
      <View class="flex-row gap-2">
        <Button
          onPress={() => (running() ? pause() : start())}
          class="flex-1 items-center rounded-(--radius) bg-primary py-2 active:opacity-80"
        >
          <Text class="text-sm font-medium text-primary-foreground">
            {running() ? "Pause" : left() > 0 && left() < length() ? "Resume" : "Start"}
          </Text>
        </Button>
        <Button
          onPress={reset}
          disabled={!running() && left() === length()}
          class="items-center rounded-(--radius) border border-border px-4 py-2 active:bg-muted disabled:opacity-40"
        >
          <Text class="text-sm text-foreground">Reset</Text>
        </Button>
      </View>
      <Text class="text-center text-xs text-muted-foreground">
        {`Focus stays in the ${platform.os === "macos" ? "menu bar" : "tray"} when closed.`}
      </Text>
    </View>
  );
}

mount(App);
