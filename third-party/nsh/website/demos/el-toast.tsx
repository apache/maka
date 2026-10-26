import { mount, Overlay, signal, Text, View } from "nsh";
import { safeArea, Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";
import { desktop, Log, size, ui, wide } from "./palette";

/** What the demo's toasts show. */
type Content = { title: string; description?: string; undo?: boolean };

function App() {
  const manager = new ToastManager();
  const shown = signal<ToastEntry[]>([]);
  const expanded = signal(false);
  const events = signal<string[]>([]);
  const log = (e: string) => events.set([e, ...events()].slice(0, 6));
  const sync = () => shown.set(manager.visible(3));
  // The lifecycle advances on the app's timer, paused while the stack is expanded.
  setInterval(() => {
    const a = manager.advance(expanded());
    for (const id of a.presented) log(`presented · ${id}`);
    for (const id of a.ending) log(`ending · ${id}`);
    for (const r of a.removed) log(`removed · ${r.id}`);
    if (a.changed) sync();
  }, 50);
  let count = 0;
  const push = (content: Content) => {
    const id = `toast-${++count}`;
    manager.push(id, content, { timeout: 5000 });
    log(`push · ${id}`);
    sync();
  };
  const dismiss = (id: string) => {
    manager.dismiss(id);
    sync();
  };
  /** A button of the demo. */
  const button = (label: string, onPress: () => void) => (
    <View
      onPress={onPress}
      activeStyle={{ opacity: 0.7 }}
      style={{ ...ui().raised, height: wide() ? size.control : 42, paddingHorizontal: 14, borderRadius: wide() ? 8 : 10, justifyContent: "center" }}
    >
      <Text style={{ fontSize: wide() ? 13 : 14, fontWeight: "600", color: ui().text }}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>toast</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Show a few; rest the pointer on the stack to expand it and stop their time" : "Show a few; touch the stack to expand it, swipe one right to dismiss it"}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("Copy the link", () => push({ title: "Copied", description: "The link is on the clipboard" }))}
        {button("Delete the draft", () => push({ title: "Draft deleted", undo: true }))}
        {button("Dismiss all", () => {
          manager.dismissAll();
          sync();
        })}
      </View>
      <Log title="ToastManager.advance · onExpandedChange" lines={events()} minHeight={130} />

      <Overlay pointerEvents="box-none" style={{ left: 0, right: 0, bottom: 0, padding: 16, paddingBottom: safeArea().bottom + 16, alignItems: wide() ? "flex-end" : "center" }}>
        <ToastStack
          placement={wide() ? "bottomRight" : "bottomCenter"}
          style={{ width: 340, maxWidth: "100%" }}
          onExpandedChange={(open) => {
            expanded.set(open);
            log(`onExpandedChange · ${open}`);
          }}
          onCancel={() => {
            const newest = shown().filter((t) => t.status !== "ending").at(-1);
            if (newest) dismiss(newest.id);
          }}
        >
          <Each of={shown()} key={(t: ToastEntry) => t.id}>
            {(t) => {
              const content = () => t().value as Content;
              return (
                <Toast
                  transitionStatus={t().status}
                  accessibilityLabel={content().title}
                  onDismissRequest={() => dismiss(t().id)}
                  class="transition-all duration-200 ease-out"
                  startingClass="opacity-0 translate-y-4"
                  endingClass="opacity-0 scale-95"
                  swipingClass="transition-none"
                  style={{ ...ui().card, flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12 }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: ui().text }}>{content().title}</Text>
                    <If when={content().description}>
                      <Text style={{ fontSize: 13, color: ui().muted }}>{content().description}</Text>
                    </If>
                  </View>
                  <If when={content().undo}>
                    <View onPress={() => dismiss(t().id)} activeStyle={{ opacity: 0.7 }} style={{ ...ui().primary, height: 28, paddingHorizontal: 10, borderRadius: 8, justifyContent: "center" }}>
                      <Text style={{ fontSize: 13, fontWeight: "600", color: ui().onPrimary }}>Undo</Text>
                    </View>
                  </If>
                </Toast>
              );
            }}
          </Each>
        </ToastStack>
      </Overlay>
    </View>
  );
}

mount(App);
