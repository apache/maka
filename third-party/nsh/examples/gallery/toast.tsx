// The gallery's toasts: `toast({ title, description, action })` from
// anywhere, shown by `<Toaster />` (placed once, in `App.tsx`), styled by the
// gallery. A styled layer built on `nsh/base`'s unstyled primitives, as
// gpui-component's notifications are on gpui-base's: a `ToastManager` keeps
// the toasts and their lifecycle, a `ToastStack` lays them out, a `Toast`
// is each one's root.
import { Overlay, signal, Text, View } from "nsh";
import { safeArea, Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";
import { colors, desktop, finish, radius } from "./ui";

/** What a toast shows. */
export interface ToastContent {
  /** Names it: showing another with the same id replaces it. */
  id?: string;
  title: string;
  description?: string;
  /** A button that closes it; `toast` resolves with this label. */
  action?: string;
  /** The label of a close button. */
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
/** Each toast's `toast` promise, and the action that closed it. */
const answers = new Map<string, (answer: string | null) => void>();
const chosen = new Map<string, string>();
let ticking: ReturnType<typeof setInterval> | undefined;
let count = 0;

function sync() {
  shown.set(manager.visible(LIMIT));
}

function tick() {
  const advanced = manager.advance(expanded());
  for (const gone of advanced.removed) {
    answers.get(gone.id)?.(chosen.get(gone.id) ?? null);
    answers.delete(gone.id);
    chosen.delete(gone.id);
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
  manager.push(id, { title: content.title, description: content.description, action: content.action, close: content.close }, { timeout: content.duration ?? 5000 });
  run();
  return new Promise((resolve) => answers.set(id, resolve));
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

/** One toast, the gallery's look. */
function Item(props: { entry: ToastEntry }) {
  const content = () => props.entry.value as ToastContent;
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
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{content().title}</Text>
        <If when={content().description}>
          <Text style={{ fontSize: 13, color: colors.muted }}>{content().description}</Text>
        </If>
      </View>
      <If when={content().action}>
        <View
          role="button"
          onPress={() => choose(props.entry.id, content().action!)}
          activeStyle={{ opacity: 0.7 }}
          style={{ paddingHorizontal: 10, height: 28, justifyContent: "center", borderRadius: radius.control, backgroundColor: colors.light }}
        >
          <Text class="text-sm font-medium text-primary-foreground">{content().action}</Text>
        </View>
      </If>
      <If when={content().close}>
        <View
          role="button"
          onPress={() => dismissToast(props.entry.id)}
          style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12 }}
        >
          <Text class="text-base text-muted-foreground">{content().close}</Text>
        </View>
      </If>
    </Toast>
  );
}

/** Where the toasts show: at the bottom, inside the safe area. */
export function Toaster() {
  return (
    <Overlay
      pointerEvents="box-none"
      style={{ left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 16, paddingBottom: safeArea().bottom + 16, alignItems: desktop() ? "flex-end" : "center" }}
    >
      <ToastStack
        placement={desktop() ? "bottomRight" : "bottomCenter"}
        style={{ width: 340, maxWidth: "100%" }}
        onExpandedChange={(open) => expanded.set(open)}
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
