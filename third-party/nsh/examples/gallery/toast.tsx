// The gallery's toasts: `toast({ title, description, kind, action })` from
// anywhere, shown by `<Toaster />` (placed once, in `App.tsx`), styled by the
// gallery. A styled layer built on `nsh/base`'s unstyled primitives, as
// gpui-component's notifications are on gpui-base's: a `ToastManager` keeps
// the toasts and their lifecycle, a `ToastStack` lays them out, a `Toast`
// is each one's root.
import { computed, createMotion, Overlay, signal, Text, View } from "nsh";
import { Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";
import { safeArea } from "nsh";
import { LucideIcon, type LucideIconName } from "./icons";
import { alpha, colors, desktop, finish, hovered, radius } from "./ui";

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

const manager = new ToastManager();
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
  answers.get(id)?.(null);
  lingering.delete(id);
  contents.set({ ...contents(), [id]: content });
  // The manager holds the id alone: the content stays in `contents`, where
  // `updateToast` changes it.
  manager.push(id, id, { timeout: content.duration ?? 5000 });
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
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: radius.inset,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.raised,
        ...finish.raised,
      }}
    >
      {() => (kind() ? <KindIcon kind={kind()!} /> : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{content().title}</Text>
        <If when={content().description}>
          <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{content().description}</Text>
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
        <View
          role="button"
          onPress={() => choose(props.entry.id, content().action!)}
          hoverStyle={{ opacity: 0.92 }}
          activeStyle={{ opacity: 0.7, transform: [{ scale: 0.96 }] }}
          style={{ paddingHorizontal: 10, height: 28, justifyContent: "center", borderRadius: radius.control, backgroundColor: colors.light, transitionProperty: "opacity, transform", transitionDuration: 120 }}
        >
          <Text class="text-sm font-medium text-primary-foreground">{content().action}</Text>
        </View>
      </If>
      <If when={content().close}>
        <View
          role="button"
          accessibilityLabel={content().close}
          onPress={() => dismissToast(props.entry.id)}
          hoverStyle={hovered()}
          activeStyle={{ backgroundColor: alpha(colors.text, 0.1) }}
          style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12 }}
        >
          <LucideIcon name="x" size={14} tint={colors.muted} />
        </View>
      </If>
    </Toast>
  );
}

/** Where the toasts show: at the bottom, inside the safe area. */
export function Toaster() {
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
