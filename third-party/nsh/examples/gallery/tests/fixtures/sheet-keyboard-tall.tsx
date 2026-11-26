import { cleanup, host, keyboardFrame, mount, platform, safeArea, Scroll, signal, Text, View, windowSize, type ViewRef } from "nsh";
import { Input, Sheet } from "nsh/base";
import { Window } from "nsh/desktop";

// #3288: a sheet taller than the room above the keyboard, with the app's
// `maxHeight: "92%"`, and a short one padded by `env(keyboard-inset-height)`.
// The same code on every platform.
function App() {
  const mode = signal<"" | "tall" | "padded">("");
  const report = signal("layout: unmeasured");
  let header: ViewRef | undefined;
  let submit: ViewRef | undefined;
  cleanup(host.on("test:measure", async () => {
    const top = await header?.measure();
    const bottom = await submit?.measure();
    if (!top || !bottom) return;
    const headerTop = top.pagePosition.y;
    const submitBottom = bottom.pagePosition.y + bottom.bounds.size.height;
    const keyboardTop = windowSize().height - keyboardFrame().height;
    const onScreen = headerTop >= safeArea().top - 1;
    // The padded sheet's submit ends right above the keyboard (its content's
    // padding between them), not a keyboard higher.
    const gap = keyboardTop - submitBottom;
    const above = mode() !== "padded" || (gap >= -1 && gap <= 48);
    report.set(onScreen && above ? "layout: ok" : `layout: header ${headerTop.toFixed(1)}, gap ${gap.toFixed(1)}`);
  }));
  const button = (m: "tall" | "padded", label: string) => (
    <View testID={`open-${m}`} role="button" onPress={() => { report.set("layout: unmeasured"); mode.set(m); }} class="rounded-full bg-primary px-6 py-3">
      <Text class="text-lg text-primary-foreground">{label}</Text>
    </View>
  );
  return (
    <View class="flex-1 items-center justify-center gap-4 bg-background">
      <Text>{`Platform: ${platform.name}`}</Text>
      <Text>{keyboardFrame().height > 0 ? "keyboard: up" : "keyboard: down"}</Text>
      <Text>{mode() === "" ? "sheet: closed" : "sheet: open"}</Text>
      <Text>{report()}</Text>
      {button("tall", "Tall sheet")}
      {button("padded", "Padded sheet")}
      <Sheet
        open={mode() !== ""}
        onOpenChange={({ open }) => !open && mode.set("")}
        popupClass={`rounded-t-3xl bg-white${mode() === "padded" ? " pb-[env(keyboard-inset-height)]" : ""}`}
        popupStyle={{ maxHeight: "92%" }}
      >
        <View class="max-h-full pb-[env(safe-area-inset-bottom)]">
          <View ref={ref => { header = ref; }} class="flex-row items-center justify-between rounded-t-3xl bg-amber-300 p-4">
            <View testID="close" role="button" onPress={() => mode.set("")} class="rounded-full bg-black px-4 py-2">
              <Text class="text-white">Close</Text>
            </View>
            <Text class="text-lg font-semibold">Header</Text>
          </View>
          <Scroll class="shrink">
            <View class="gap-3 p-4">
              <Input testID="title" placeholder="Title" class="min-h-12 rounded-xl bg-gray-100 px-4" />
              {Array.from({ length: mode() === "tall" ? 10 : 2 }, (_, i) => (
                <View class="min-h-12 justify-center rounded-xl bg-sky-200 px-4">
                  <Text>Row {i + 1}</Text>
                </View>
              ))}
              <View testID="submit" ref={ref => { submit = ref; }} role="button" class="min-h-12 items-center justify-center rounded-xl bg-black">
                <Text class="text-white">Submit</Text>
              </View>
            </View>
          </Scroll>
        </View>
      </Sheet>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
