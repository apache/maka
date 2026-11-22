import { Image, type JSX, signal, Text, View } from "nsh";
import bounce from "../bounce.gif";
import logo from "../logo@2x.png";
import mark from "../mark.svg";
import spinner from "../spinner.webp";
import star from "../star.svg";
import { alpha, Appear, Badge, Button, Caption, Card, colors, DemoPage, Meter, mono, photoUrl, type PhotoName, type PhotoSize, radius } from "../ui";

// The one picture the demos of a single image compare themselves on.
const launch = photoUrl("arc");
// A remote SVG (Twemoji's rocket, CC BY 4.0).
const remoteSvg = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f680.svg";

/** Every photo's frame: rounded, a hairline border, a raised fill while it loads. */
const frame = () => ({ borderRadius: radius.control, borderCurve: "continuous", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised }) as const;

/** A quiet label under a tile (`code` for API values). */
function Note(props: { children: string; code?: boolean }) {
  return (
    <Text style={{ numberOfLines: 1, fontSize: 13, color: colors.muted, fontFamily: props.code ? mono : undefined, fontVariant: ["tabular-nums"], textAlign: "center" }}>
      {props.children}
    </Text>
  );
}

/** A tile on the inset: something centered on a raised square, a note below. */
function Tile(props: { note: string; code?: boolean; height?: number; children: JSX.Element }) {
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View
        style={{
          height: props.height ?? 76,
          borderRadius: radius.control,
          borderCurve: "continuous",
          backgroundColor: colors.inset,
          borderWidth: 1,
          borderColor: colors.line,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {props.children}
      </View>
      <Note code={props.code}>{props.note}</Note>
    </View>
  );
}

/** A portrait photo in wide frames, one per `objectFit` value. */
function ResizeModes() {
  const rows = [
    ["cover", "contain"],
    ["fill", "none"],
  ] as const;
  return (
    <Card icon="image" title="Resize modes" subtitle="A portrait photo in wide frames">
      <Each of={rows}>
        {(row) => (
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Each of={row()}>
              {(mode) => (
                <View style={{ flex: 1, gap: 8 }}>
                  <Image src={launch} style={{ ...frame(), height: 150, objectFit: mode() }} />
                  <Note code>{mode()}</Note>
                </View>
              )}
            </Each>
          </View>
        )}
      </Each>
    </Card>
  );
}

function Corners() {
  const square = () => ({ ...frame(), width: 88, height: 88 }) as const;
  return (
    <Card icon="styles" title="Corners and borders" subtitle="Radii per corner, borders on the image">
      <View style={{ flexDirection: "row" }}>
        <View style={{ flex: 1, alignItems: "center", gap: 8 }}>
          <Image src={photoUrl("silver")} style={{ ...square(), borderRadius: 44 }} />
          <Note>Circle</Note>
        </View>
        <View style={{ flex: 1, alignItems: "center", gap: 8 }}>
          <Image src={photoUrl("rays")} style={{ ...square(), borderRadius: 18, borderWidth: 2, borderColor: colors.accent }} />
          <Note>Border</Note>
        </View>
        <View style={{ flex: 1, alignItems: "center", gap: 8 }}>
          <Image src={photoUrl("day")} style={{ ...square(), borderRadius: 0, borderTopLeftRadius: 40, borderBottomRightRadius: 40 }} />
          <Note>Two corners</Note>
        </View>
      </View>
    </Card>
  );
}

function Assets() {
  const tints = [
    { label: "Accent", tone: "accent" },
    { label: "Info", tone: "info" },
    { label: "Danger", tone: "danger" },
  ] as const;
  return (
    <Card icon="star" title="Assets and tint" subtitle="logo@2x.png, tinted natively">
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Tile note="Original">
          <Image src={logo} />
        </Tile>
        <Each of={tints}>
          {(tint) => (
            <Tile note={tint().label}>
              <Image src={logo} style={{ tintColor: colors[tint().tone] }} />
            </Tile>
          )}
        </Each>
      </View>
    </Card>
  );
}

/** SVG images: a spark tinted at three sizes and with its own gradient, a
 * night launch fitted two ways (`objectFit`), and an SVG from a URL. */
function Svg() {
  const sizes = [18, 32, 56];
  const modes = ["contain", "cover"] as const;
  return (
    <Card icon="star" title="SVG images" subtitle="star.svg, mark.svg and a remote SVG, sharp at every size">
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Each of={sizes}>
          {(size) => (
            <Tile note={`${size()} pt`} height={96}>
              <Image testID={`svg-star-${size()}`} src={star} style={{ width: size(), height: size(), tintColor: colors.accent }} />
            </Tile>
          )}
        </Each>
        <Tile note="As drawn" height={96}>
          <Image testID="svg-star-plain" src={star} style={{ width: 36, height: 36 }} />
        </Tile>
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Each of={modes}>
          {(mode) => (
            <View style={{ flex: 1, gap: 8 }}>
              <Image testID={`svg-mark-${mode()}`} src={mark} style={{ ...frame(), height: 96, objectFit: mode() }} />
              <Note code>{mode()}</Note>
            </View>
          )}
        </Each>
        <View style={{ flex: 1, gap: 8 }}>
          <View style={{ ...frame(), height: 96, padding: 14, backgroundColor: colors.inset }}>
            <Image testID="svg-remote" src={remoteSvg} style={{ flex: 1, objectFit: "contain" }} />
          </View>
          <Note>Remote</Note>
        </View>
      </View>
    </Card>
  );
}

function Animated() {
  return (
    <Card icon="animation" title="Animated GIF and WebP" subtitle="Decoded and played natively">
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Tile note="bounce.gif" code height={96}>
          <Image src={bounce} style={{ width: 64, height: 64 }} />
        </Tile>
        <Tile note="spinner.webp" code height={96}>
          <Image src={spinner} style={{ width: 64, height: 64 }} />
        </Tile>
        <Tile note="Scaled, round" height={96}>
          <Image src={bounce} style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: alpha(colors.accent, 0.14) }} />
        </Tile>
      </View>
    </Card>
  );
}

/** Network images behind a placeholder, fading in; "Reload" asks for
 * images that are not cached yet. */
function Placeholders() {
  const seed = signal(1);
  // Another size per reload: a URL not in the cache yet.
  const sizes: PhotoSize[] = ["medium", "small", "900x900", "large", "360x360"];
  const fades = [
    { name: "dragon" as PhotoName, ms: 0 },
    { name: "transporter" as PhotoName, ms: 300 },
    { name: "moon" as PhotoName, ms: 1000 },
  ];
  return (
    <Card
      icon="photos"
      title="Placeholder and fade"
      subtitle="A placeholder, then a fade"
      right={<Button label="Reload" variant="secondary" onPress={() => seed.set(seed() + 1)} />}
    >
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Each of={fades}>
          {(fade) => (
            <View style={{ flex: 1, gap: 8 }}>
              <Image
                src={photoUrl(fade().name, sizes[(seed() - 1) % sizes.length])}
                placeholder={logo}
                fadeDuration={fade().ms}
                style={{ ...frame(), height: 100 }}
              />
              <Note>{`${fade().ms} ms`}</Note>
            </View>
          )}
        </Each>
      </View>
      <Caption label="Loads" note={`${seed()}`} />
    </Card>
  );
}

function Blur() {
  const radii = [0, 2, 6, 16];
  return (
    <Card icon="spark" title="Blur radius" subtitle="blurRadius, applied while decoding">
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Each of={radii}>
          {(r) => (
            <View style={{ flex: 1, gap: 8 }}>
              <Image src={launch} blurRadius={r()} style={{ ...frame(), height: 76 }} />
              <Note>{r() === 0 ? "None" : `${r()} pt`}</Note>
            </View>
          )}
        </Each>
      </View>
    </Card>
  );
}

function Info() {
  const big = photoUrl("booster", "4096x4096");
  const size = signal("—");
  const prefetched = signal("—");
  const progress = signal(0);
  const status = signal("not shown");
  const show = signal(false);
  return (
    <Card icon="search" title="Size, prefetch, progress" subtitle="Image.getSize · Image.prefetch · onProgress">
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button
            label="Size"
            variant="secondary"
            onPress={() =>
              Image.getSize(big).then(
                (s) => size.set(`${s.width}×${s.height} px`),
                (e) => size.set(String(e)),
              )
            }
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label="Prefetch"
            variant="secondary"
            onPress={() => {
              prefetched.set("loading…");
              Image.prefetch(big).then(
                () => prefetched.set("in memory"),
                () => prefetched.set("failed"),
              );
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button label={show() ? "Hide" : "Show"} variant={show() ? "secondary" : "accent"} onPress={() => show.set(!show())} />
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Caption label="getSize" note={size()} />
        <Caption label="prefetch" note={prefetched()} />
        <Caption label="onProgress" note={`${Math.round(progress() * 100)}% · ${status()}`} />
        <Meter value={progress()} tone={progress() >= 1 ? "up" : "accent"} />
      </View>
      <If when={show()} else={<Note>Prefetch, then show: no download, no progress</Note>}>
        <Appear>
          <Image
            src={big}
            onLoadStart={() => status.set("loading")}
            onProgress={(e) => progress.set(e.loaded / Math.max(1, e.total))}
            onLoad={() => {
              if (progress() === 0) status.set("loaded (no download)");
              else status.set("loaded");
              progress.set(1);
            }}
            style={{ ...frame(), height: 170 }}
          />
        </Appear>
      </If>
    </Card>
  );
}

function Events() {
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([...events(), line]);
  const loaded = signal("…");
  const failed = signal("Loading…");
  const thumb = () => ({ ...frame(), width: 96, height: 64 }) as const;
  return (
    <Card icon="bell" title="Events" subtitle="Load start, load, error, load end">
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <Image
          src={photoUrl("liftoff")}
          onLoadStart={() => log("onLoadStart")}
          onLoad={(e) => {
            log("onLoad");
            loaded.set(`${e.size.width}×${e.size.height}`);
          }}
          onError={(e) => loaded.set(e.message)}
          onLoadEnd={() => log("onLoadEnd")}
          style={thumb()}
        />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 15, color: colors.text }}>pbs.twimg.com</Text>
          <Text style={{ fontSize: 13, color: colors.up, fontVariant: ["tabular-nums"] }}>{`Loaded, ${loaded()} px`}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12 }}>
        <View style={{ ...thumb(), alignItems: "center", justifyContent: "center", borderColor: alpha(colors.danger, 0.4) }}>
          <Image src="https://example.invalid/missing.png" onError={(e) => failed.set(e.message)} style={{ ...thumb(), position: "absolute", left: -1, top: -1, borderWidth: 0 }} />
          <Text style={{ fontSize: 20, color: colors.danger }}>×</Text>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 15, color: colors.text }}>example.invalid</Text>
          <Text style={{ numberOfLines: 3, fontSize: 13, color: colors.danger }}>{failed()}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <If when={events().length > 0} else={<Note>No load events yet</Note>}>
          <Each of={events()}>{(e) => <Badge label={e()} tone={e() === "onLoad" ? "up" : "neutral"} />}</Each>
        </If>
      </View>
    </Card>
  );
}

export function Images() {
  const cards = [ResizeModes, Corners, Assets, Svg, Animated, Placeholders, Blur, Info, Events];
  return <DemoPage cards={cards} columns={3} />;
}
