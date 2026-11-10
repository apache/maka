// The gallery's toasts: `toast({ title, description, kind, action })` from
// anywhere, shown by `<Toaster />` (placed once, in `App.tsx`), styled by the
// gallery. A styled layer built on `nsh/base`'s unstyled primitives, as
// gpui-component's notifications are on gpui-base's: a `ToastManager` keeps
// the toasts and their lifecycle, a `ToastStack` lays them out, a `Toast`
// is each one's root.
import { cleanup, computed, createMotion, Overlay, signal, Text, View } from "nsh";
import { Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";
import { safeArea } from "nsh";
import { play, type SoundName } from "../nsh-gallery-ui/sound";
import { LucideIcon, type LucideIconName } from "./icons";
import { colors, desktop, TERMINAL_COLUMN, terminal, toastActionLabel, toastActionLook, toastCloseLook, toastLook, toastText, toastTitle } from "./ui";

/** What a toast is about: the icon and the tone it shows. */
export type ToastKind = "success" | "error" | "warning" | "info" | "loading";

/** What a toast shows. */
export interface ToastContent {
  /** Names it: showing another with the same id replaces it. */
  id?: string;
  title: string;
  description?: string;
  /** The icon at its leading edge; `"loading"` spins until updated. */
  kind?: ToastKind;
  /** A bar under the text, 0 to 1: how far the work it reports is. */
  progress?: number;
  /** A button that closes it; `toast` resolves with this label. */
  action?: string;
  /** The accessible label of a close button (the button shows a cross). */
  close?: string;
  /** Milliseconds it stays (5000); `Infinity` until dismissed. */
  duration?: number;
}

/** How many show at once. */
const LIMIT = 3;
/** How often the lifecycle advances while a toast is mounted. */
const TICK = 50;

// A terminal's toast goes in one frame: no exit to wait for.
const manager = new ToastManager(terminal ? { exitDuration: 0 } : undefined);
const shown = signal<ToastEntry[]>([]);
const expanded = signal(false);
/** What each toast shows now: `updateToast` changes it in place. */
const contents = signal<Record<string, ToastContent>>({});
/** Each toast's `toast` promise, and the action that closed it. */
const answers = new Map<string, (answer: string | null) => void>();
const chosen = new Map<string, string>();
/** The time left of toasts `updateToast` gave a new duration: the manager
 * keeps a toast's timeout from its push, so these count here, paused with
 * the stack as the manager's are. */
const lingering = new Map<string, number>();
let ticking: ReturnType<typeof setInterval> | undefined;
let count = 0;

/** The sound a toast of a kind makes as it shows: none while it loads, none
 * without a kind. */
const voices: Partial<Record<ToastKind, SoundName>> = { success: "success", error: "error", warning: "warning", info: "attention" };

function sync() {
  shown.set(manager.visible(LIMIT));
}

function tick() {
  if (!expanded()) {
    for (const [id, left] of lingering) {
      if (left - TICK > 0) lingering.set(id, left - TICK);
      else {
        lingering.delete(id);
        manager.dismiss(id);
      }
    }
  }
  const advanced = manager.advance(expanded());
  for (const gone of advanced.removed) {
    answers.get(gone.id)?.(chosen.get(gone.id) ?? null);
    answers.delete(gone.id);
    chosen.delete(gone.id);
    lingering.delete(gone.id);
    const { [gone.id]: _, ...rest } = contents();
    contents.set(rest);
  }
  if (advanced.changed) sync();
  if (manager.isEmpty() && ticking !== undefined) {
    clearInterval(ticking);
    ticking = undefined;
  }
}

function run() {
  sync();
  ticking ??= setInterval(tick, TICK);
}

/** Shows a toast; resolves once it is gone, with its action if that closed it. */
export function toast(content: ToastContent): Promise<string | null> {
  const id = content.id ?? `toast-${++count}`;
  // A terminal shows one toast, on its bottom row: a new one replaces the
  // others.
  if (terminal) for (const e of shown()) if (e.id !== id) manager.dismiss(e.id);
  answers.get(id)?.(null);
  lingering.delete(id);
  contents.set({ ...contents(), [id]: content });
  // The manager holds the id alone: the content stays in `contents`, where
  // `updateToast` changes it.
  manager.push(id, id, { timeout: content.duration ?? 5000 });
  const voice = content.kind && voices[content.kind];
  if (voice) play(voice);
  run();
  return new Promise((resolve) => answers.set(id, resolve));
}

/**
 * Changes the toast `id` where it is, without showing it again (a loading
 * toast becoming its result, its progress moving); a `duration` starts its
 * time over. False when no such toast shows.
 */
export function updateToast(id: string, change: Partial<ToastContent>): boolean {
  const content = contents()[id];
  if (!content) return false;
  contents.set({ ...contents(), [id]: { ...content, ...change } });
  // A loading toast becoming its result sounds as a new one would.
  const voice = change.kind && change.kind !== content.kind && voices[change.kind];
  if (voice) play(voice);
  if (change.duration !== undefined) {
    if (Number.isFinite(change.duration)) lingering.set(id, change.duration);
    else lingering.delete(id);
  }
  return true;
}

/** Closes the toast `id`, every toast without one. */
export function dismissToast(id?: string) {
  if (id === undefined) manager.dismissAll();
  else manager.dismiss(id);
  run();
}

function choose(id: string, action: string) {
  chosen.set(id, action);
  dismissToast(id);
}

const kinds: Record<ToastKind, { icon: LucideIconName; tint: () => string }> = {
  success: { icon: "circle-check", tint: () => colors.up },
  error: { icon: "circle-x", tint: () => colors.danger },
  warning: { icon: "triangle-alert", tint: () => colors.warn },
  info: { icon: "info", tint: () => colors.info },
  loading: { icon: "loader-circle", tint: () => colors.muted },
};

/** A kind's icon: it pops in each time the kind changes, and a loading one spins. */
function KindIcon(props: { kind: ToastKind }) {
  const m = createMotion(props.kind === "loading" ? {} : { enter: "zoomIn", duration: 220 });
  if (props.kind === "loading") void m.play("spin", { duration: 900 });
  return (
    <View style={{ width: 18, height: 18, ...m.style }}>
      <LucideIcon name={kinds[props.kind].icon} size={18} tint={kinds[props.kind].tint()} />
    </View>
  );
}

/** A terminal's mark of each kind, in its tone. */
const marks: Record<Exclude<ToastKind, "loading">, string> = { success: "✓", error: "✗", warning: "!", info: "i" };
/** The frames of a terminal's loading mark. */
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** A terminal's mark of a kind: a loading one spins, a frame at a time. */
function KindMark(props: { kind: ToastKind }) {
  if (props.kind !== "loading") {
    return <Text style={{ fontWeight: "600", color: kinds[props.kind].tint() }}>{marks[props.kind]}</Text>;
  }
  const frame = signal(0);
  const timer = setInterval(() => frame.set((frame() + 1) % SPINNER.length), 80);
  cleanup(() => clearInterval(timer));
  return <Text style={{ color: colors.muted }}>{SPINNER[frame()]}</Text>;
}

/**
 * One toast in a terminal: a row of the bottom line, its mark, its title
 * and its muted description, then its action and its cross at the end.
 */
function TerminalItem(props: { entry: ToastEntry }) {
  const content = () => contents()[props.entry.id] ?? { title: "" };
  const kind = computed(() => content().kind);
  return (
    <Toast
      transitionStatus={props.entry.status}
      accessibilityLabel={[content().title, content().description].filter(Boolean).join(". ")}
      onDismissRequest={() => dismissToast(props.entry.id)}
      swipeDirection={null}
      style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: TERMINAL_COLUMN, paddingHorizontal: TERMINAL_COLUMN }}
    >
      {() => (kind() ? <KindMark kind={kind()!} /> : null)}
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: TERMINAL_COLUMN }}>
        <Text style={{ numberOfLines: 1, fontWeight: "600", color: colors.text }}>{content().title}</Text>
        <If when={content().description}>
          <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, color: colors.muted }}>{content().description}</Text>
        </If>
      </View>
      <If when={content().action}>
        <View role="button" onPress={() => choose(props.entry.id, content().action!)}>
          <Text style={{ fontWeight: "600", color: colors.info }}>{content().action}</Text>
        </View>
      </If>
      <View role="button" accessibilityLabel={content().close ?? "Close"} onPress={() => dismissToast(props.entry.id)}>
        <Text style={{ color: colors.muted }}>×</Text>
      </View>
    </Toast>
  );
}

/** One toast, the gallery's look. */
function Item(props: { entry: ToastEntry }) {
  const content = () => contents()[props.entry.id] ?? { title: "" };
  const kind = computed(() => content().kind);
  const progress = () => Math.max(0, Math.min(1, content().progress ?? 0));
  return (
    <Toast
      transitionStatus={props.entry.status}
      accessibilityLabel={[content().title, content().description].filter(Boolean).join(". ")}
      onDismissRequest={() => dismissToast(props.entry.id)}
      class="transition-all duration-200 ease-out"
      startingClass="opacity-0 translate-y-4"
      endingClass="opacity-0 scale-95"
      swipingClass="transition-none"
      style={toastLook()}
    >
      {() => (kind() ? <KindIcon kind={kind()!} /> : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={toastTitle()}>{content().title}</Text>
        <If when={content().description}>
          <Text style={toastText()}>{content().description}</Text>
        </If>
        <If when={content().progress !== undefined}>
          <View style={{ height: 4, marginTop: 6, borderRadius: 2, overflow: "hidden", backgroundColor: colors.track }}>
            <View
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: kind() === "success" ? colors.up : colors.accentFill,
                transformOrigin: "left",
                transform: [{ scaleX: progress() }],
                transitionProperty: "transform, background-color",
                transitionDuration: 300,
                transitionTimingFunction: "ease-out",
              }}
            />
          </View>
        </If>
      </View>
      <If when={content().action}>
        <View role="button" onPress={() => choose(props.entry.id, content().action!)} {...toastActionLook()}>
          <Text style={toastActionLabel()}>{content().action}</Text>
        </View>
      </If>
      <If when={content().close}>
        <View
          role="button"
          accessibilityLabel={content().close}
          onPress={() => dismissToast(props.entry.id)}
          {...toastCloseLook()}
        >
          <LucideIcon name="x" size={14} tint={colors.muted} />
        </View>
      </If>
    </Toast>
  );
}

/** Where the toasts show: at the bottom, inside the safe area; a terminal's on its bottom row. */
export function Toaster() {
  if (terminal) {
    return (
      <ToastStack
        onCancel={() => {
          const newest = shown().filter((e) => e.status !== "ending").at(-1);
          if (newest) dismissToast(newest.id);
        }}
      >
        <Each of={shown()} key={(e: ToastEntry) => e.id}>
          {(entry) => <TerminalItem entry={entry()} />}
        </Each>
      </ToastStack>
    );
  }
  return (
    <Overlay
      style={{ pointerEvents: "box-none", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 16, paddingBottom: safeArea().bottom + 16, alignItems: desktop() ? "flex-end" : "center" }}
    >
      <ToastStack
        placement={desktop() ? "bottomRight" : "bottomCenter"}
        style={{ width: 340, maxWidth: "100%" }}
        onExpandedChange={({ expanded: open }) => expanded.set(open)}
        onCancel={() => {
          const newest = shown().filter((e) => e.status !== "ending").at(-1);
          if (newest) dismissToast(newest.id);
        }}
      >
        <Each of={shown()} key={(e: ToastEntry) => e.id}>
          {(entry) => <Item entry={entry()} />}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
