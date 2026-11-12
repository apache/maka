import { mount, signal, Text, View } from "nsh";
import { colorScheme, fontScale, pixelRatio, platform, windowSize } from "nsh";

function Row(props: { label: string; value: string }) {
  return (
    <View class="flex-row py-2 border-b border-line">
      <Text class="flex-1 text-muted-foreground">{props.label}</Text>
      <Text class="text-foreground">{props.value}</Text>
    </View>
  );
}

function App() {
  const hairline = () => 1 / pixelRatio();
  const rtl = signal(false);
  return (
    <View class="flex-1 bg-background px-4 pt-6 gap-4">
      <Text class="text-2xl font-bold text-foreground">Environment</Text>
      <View class="rounded-2xl bg-card border border-border px-4 py-1">
        <Row label="windowSize()" value={`${Math.round(windowSize().width)} × ${Math.round(windowSize().height)}`} />
        <Row label="colorScheme()" value={colorScheme()} />
        <Row label="fontScale()" value={fontScale().toFixed(2)} />
        <Row label="platform.os" value={platform.os} />
        <Row label="platform.version" value={platform.version} />
        <Row label="platform.idiom" value={platform.idiom} />
        <Row label="platform.desktop" value={String(platform.desktop)} />
        <Row label="Locale" value={new Intl.DateTimeFormat().resolvedOptions().locale} />
        <Row label="pixelRatio()" value={String(pixelRatio())} />
      </View>

      <Text class="text-muted-foreground">
        {platform.select({ ios: "Running on iOS.", android: "Running on Android.", web: "Running in a browser.", default: "Running elsewhere." })}
      </Text>

      <View class="gap-1">
        <View class="bg-faint" style={{ height: hairline() }} />
        <Text class="text-xs text-faint">The line above is one device pixel tall.</Text>
      </View>

      <View class={windowSize().width >= 600 ? "flex-row gap-3" : "gap-3"}>
        <View class="flex-1 rounded-xl bg-brand dark:bg-primary p-4">
          <Text class="text-white dark:text-primary-foreground font-semibold">dark: classes follow the system</Text>
        </View>
        <View class="flex-1 rounded-xl bg-card border border-border p-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
          <Text class="text-foreground font-semibold">A row only when the window is 600 pt or wider</Text>
        </View>
      </View>

      <View
        onPress={() => rtl.set(!rtl())}
        activeStyle={{ opacity: 0.6 }}
        style={{ direction: rtl() ? "rtl" : "ltr" }}
        class="flex-row items-center gap-3 rounded-2xl bg-card border border-border p-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Text class="text-lg text-brand">⇄</Text>
        <Text class="flex-1 text-foreground">Lay out right to left: {rtl() ? "on" : "off"}</Text>
      </View>
    </View>
  );
}

mount(App);
