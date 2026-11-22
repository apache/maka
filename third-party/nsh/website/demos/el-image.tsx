import { Image, mount, signal, Text, View } from "nsh";
import { windowSize } from "nsh";
import { Toggle } from "nsh/base";
import { toggleLabel, toggleLook, ui, Log, Segmented, insetSurface } from "./palette";

// The pictures are SVG `data:` URIs, so the demo needs no network. An app
// would import a file next to it (`import hills from "./hills.png"`) or pass
// a URL. Each names its size in a label at its middle, which every
// `objectFit` keeps in view (`cover` crops the edges).
const svg = (body: string, width: number, height: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;

const landscape = svg(
  `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ea8ff"/><stop offset="1" stop-color="#ffd59e"/></linearGradient></defs>
  <rect width="1200" height="800" fill="url(#s)"/>
  <circle cx="880" cy="250" r="90" fill="#fff4c2"/>
  <path d="M0 560 Q 250 380 520 520 T 1200 470 V800 H0Z" fill="#6aa86b"/>
  <path d="M0 650 Q 330 520 700 640 T 1200 610 V800 H0Z" fill="#3f7d4c"/>
  <rect x="430" y="362" width="340" height="76" rx="38" fill="#000000" fill-opacity="0.32"/>
  <text x="600" y="415" text-anchor="middle" font-family="system-ui" font-size="44" font-weight="600" fill="#ffffff">1200 × 800</text>`,
  1200,
  800,
);

const portrait = svg(
  `<defs><linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1f3a"/><stop offset="1" stop-color="#b79cff"/></linearGradient></defs>
  <rect width="600" height="900" fill="url(#n)"/>
  <circle cx="300" cy="260" r="120" fill="#f4f1ff"/>
  <circle cx="350" cy="230" r="110" fill="#2a2f55"/>
  <path d="M0 700 L 180 520 L 330 660 L 450 560 L 600 700 V900 H0Z" fill="#141629"/>
  <rect x="150" y="512" width="300" height="76" rx="38" fill="#000000" fill-opacity="0.32"/>
  <text x="300" y="565" text-anchor="middle" font-family="system-ui" font-size="44" font-weight="600" fill="#ffffff">600 × 900</text>`,
  600,
  900,
);

// Shown until the picture loads, and in its place when it fails.
const placeholder = svg(
  `<rect width="120" height="80" fill="#8d9198" opacity="0.25"/><path d="M20 62 L48 34 L68 52 L80 42 L100 62Z" fill="#8d9198"/><circle cx="86" cy="24" r="8" fill="#8d9198"/>`,
  120,
  80,
);

// An icon drawn in one color: `tintColor` recolors it.
const star = svg(`<path d="M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21.1l1.5-7L2 9.3l7-.8z" fill="#000"/>`, 24, 24);

const sources = { landscape, portrait, missing: "asset:/missing.png" } as const;
type Source = keyof typeof sources;
const modes = ["cover", "contain", "fill", "none"] as const;
type Mode = (typeof modes)[number];

function App() {
  const source = signal<Source>("landscape");
  const mode = signal<Mode>("cover");
  const blur = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  const wide = () => windowSize().width >= 700;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>image</Text>
      <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 16 }}>
        <Image
          src={sources[source()]}
          placeholder={placeholder}
          blurRadius={blur() ? 12 : 0}
          fadeDuration={250}
          onLoadStart={() => log("onLoadStart")}
          onLoad={({ size }) => log(`onLoad ${Math.round(size.width)} × ${Math.round(size.height)}`)}
          onError={(e) => log(`onError ${e.message}`)}
          onLoadEnd={() => log("onLoadEnd")}
          style={{ ...insetSurface(), flex: 1, minHeight: 180, objectFit: mode() }}
        />
        <View style={{ gap: 12, width: wide() ? 320 : undefined }}>
          <Segmented label="src" options={Object.keys(sources) as Source[]} value={source()} onChange={(s) => source.set(s)} />
          <Segmented label="objectFit" options={modes} value={mode()} onChange={(m) => mode.set(m)} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Toggle pressed={blur()} onChange={({ pressed }) => blur.set(pressed)} {...toggleLook({ variant: "outline", text: true })}>
              <Text style={toggleLabel(blur, { text: true })}>blurRadius {blur() ? 12 : 0}</Text>
            </Toggle>
            <Text style={{ color: ui().muted }}>tintColor</Text>
            <Image src={star} style={{ width: 24, height: 24, tintColor: ui().accent }} />
            <Image src={star} style={{ width: 24, height: 24, tintColor: ui().info }} />
          </View>
          <Log title="Events, newest first" lines={events()} minHeight={92} />
        </View>
      </View>
    </View>
  );
}

mount(App);
