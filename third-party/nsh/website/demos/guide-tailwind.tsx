import { mount, Scroll, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  const busy = signal(false);
  const tab = signal("Day");
  const tabs = ["Day", "Week", "Month"];

  const buttons = () => (
    <View class="flex-row flex-wrap gap-2">
      <View
        onPress={() => count.update((n) => n + 1)}
        class="rounded-lg bg-lime-300 px-4 py-2 transition-colors duration-150 motion-reduce:transition-none hover:bg-lime-200 active:bg-lime-400 focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <Text class="font-medium text-lime-950">Pressed {count()}×</Text>
      </View>
      <View
        onPress={() => busy.set(!busy())}
        class="rounded-lg border border-black/10 bg-white px-4 py-2 shadow-sm transition motion-reduce:transition-none hover:bg-zinc-50 active:scale-95 active:bg-zinc-100 dark:border-[#2c2e33] dark:bg-[#24262a] dark:hover:bg-[#2a2c31] dark:active:bg-[#2d2f34] focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <Text class="font-medium text-[#15161a] dark:text-[#eceef1]">{busy() ? "Enable" : "Disable"}</Text>
      </View>
      <View disabled={busy()} onPress={() => count.set(0)} class="rounded-lg bg-emerald-400 px-4 py-2 enabled:hover:bg-emerald-300 active:bg-emerald-500 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-sky-500">
        <Text class="font-medium text-emerald-950">Reset</Text>
      </View>
    </View>
  );
  const tabsRow = () => (
    <View class="flex-row rounded-xl border border-black/5 bg-[#ecece7] p-1 dark:border-[#1f2124] dark:bg-[#0c0d0f]">
      <Each of={tabs}>
        {(t) => (
          <View
            onPress={() => tab.set(t())}
            class="flex-1 items-center rounded-lg py-2 transition-colors motion-reduce:transition-none active:opacity-70 focus-visible:outline-2 focus-visible:outline-sky-500"
            classList={{ "bg-white shadow-sm dark:bg-[#2a2c31]": tab() === t(), "hover:bg-black/5 dark:hover:bg-white/5": tab() !== t() }}
          >
            <Text class="text-sm font-medium" classList={{ "text-[#15161a] dark:text-[#eceef1]": tab() === t(), "text-[#565a61] dark:text-[#8d9198]": tab() !== t() }}>
              {t()}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
  const gradient = () => (
    <View class="overflow-hidden rounded-2xl bg-linear-to-br from-lime-300 via-emerald-300 to-sky-400 p-5 shadow-xl shadow-lime-300/20">
      <Text class="text-xl font-bold text-zinc-950">{tab()} view</Text>
      <Text class="mt-1 text-sm text-zinc-950/70">bg-linear-to-br from-lime-300 via-emerald-300 to-sky-400</Text>
    </View>
  );
  const grid = () => (
    <View class="grid grid-cols-3 gap-2">
      <View class="col-span-2 h-14 items-center justify-center rounded-lg bg-sky-950">
        <Text class="text-xs text-sky-200">col-span-2</Text>
      </View>
      <View class="h-14 rounded-lg bg-sky-900" />
      <View class="h-14 rounded-lg bg-sky-800" />
      <View class="row-span-2 rounded-lg bg-sky-400" />
      <View class="h-14 rounded-lg bg-sky-700" />
      <View class="h-14 rounded-lg bg-sky-600" />
      <View class="h-14 rounded-lg bg-sky-500" />
    </View>
  );
  const list = () => (
    <View class="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm dark:border-[#2c2e33] dark:bg-[#18191c]">
      <Each of={["Inbox", "Drafts", "Sent", "Archive"]}>
        {(item) => (
          <View class="flex-row items-center justify-between border-t border-black/5 px-4 py-3 first:border-t-0 even:bg-[#fafaf7] active:bg-lime-50 dark:border-[#1f2124] dark:even:bg-[#141518] dark:active:bg-[#24262a]">
            <Text class="text-[#15161a] dark:text-[#eceef1]">{item()}</Text>
            <Text class="text-[#8c9097] dark:text-[#5a5e65]">›</Text>
          </View>
        )}
      </Each>
    </View>
  );
  const motion = () => (
    <View class="flex-row items-center justify-around py-2">
      <View class="size-8 animate-spin motion-reduce:animate-none rounded-md bg-lime-300" />
      <View class="size-8 animate-bounce motion-reduce:animate-none rounded-full bg-sky-400" />
      <View class="h-8 w-14 animate-pulse motion-reduce:animate-none rounded-md bg-[#e1e1db] dark:bg-[#2c2e33]" />
    </View>
  );

  return (
    <Scroll class="flex-1 bg-[#f3f3ef] dark:bg-[#101113]">
      <View class="gap-5 p-5 pt-6">
        <Text class="text-2xl font-bold tracking-tight text-[#15161a] dark:text-[#eceef1]">Tailwind classes</Text>
        {/* Two columns from `md:` on (768 points): breakpoints follow the window. */}
        <View class="gap-5 md:flex-row md:items-start">
          <View class="gap-5 md:min-w-0 md:flex-1">
            {buttons()}
            {tabsRow()}
            {gradient()}
          </View>
          <View class="gap-5 md:min-w-0 md:flex-1">
            {grid()}
            {list()}
            {motion()}
          </View>
        </View>
      </View>
    </Scroll>
  );
}

mount(App);
