import { signal, View, type WebViewRef } from "nsh";
import { Canvas } from "nsh";
import { windowSize } from "nsh";
import { Menu } from "nsh/desktop";
import { Image } from "nsh";
import { WebView } from "nsh";
import Pacifico from "./assets/Pacifico-Regular.ttf";
import runtimeImage from "./assets/runtime.png";
import { Action, Label, palette as p } from "./ui";

/** Optional visual samples keep the operations view's ordinary layout compact. */
export function EffectsInspector() {
  const blur = signal(false);
  const pulse = signal(false);
  const multiply = signal(false);
  const options = () => Menu.popup([
    { label: "Soft focus", checked: blur(), onSelect: () => blur.set(!blur()) },
    { label: "Pulse layer", checked: pulse(), onSelect: () => pulse.set(!pulse()) },
    { type: "separator" },
    { label: "Blend mode", submenu: [
      { label: "Screen", checked: !multiply(), onSelect: () => multiply.set(false) },
      { label: "Multiply", checked: multiply(), onSelect: () => multiply.set(true) },
    ] },
  ], { x: windowSize().width - 240, y: 128 });
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 16 }}>
      <View>
        <View style={{ height: 16, flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}><Label strong color={p.ink}>Surface effects</Label></View>
          <Action label="Options" testID="effects-options" onPress={options} />
        </View>
        <Label color={p.faint}>Local visual samples</Label>
      </View>
      <View style={{ height: 64, overflow: "hidden", backgroundColor: p.page }}>
        <View style={{ position: "absolute", left: 16, top: 16, width: 112, height: 48, backgroundColor: p.mint, opacity: 0.85 }} />
        <View style={{ position: "absolute", left: 80, top: 16, width: 112, height: 48, backgroundColor: p.blue, mixBlendMode: multiply() ? "multiply" : "screen", opacity: 0.8, animationName: pulse() ? "pulse" : "none", animationDuration: 1400, animationIterationCount: "infinite" }} />
      </View>
      <View style={{ height: 16, flexDirection: "row", gap: 8 }}>
        <Action testID="effects-blend" label={multiply() ? "Multiply" : "Screen"} active={multiply()} onPress={() => multiply.set(!multiply())} />
        <Action testID="effects-pulse" label={pulse() ? "Stop pulse" : "Pulse"} active={pulse()} onPress={() => pulse.set(!pulse())} />
      </View>
      <View><Label strong color={p.ink}>Image treatment</Label><Label color={p.faint}>{blur() ? "Soft focus / 3pt" : "Original / sharp"}</Label></View>
      <View style={{ height: 64, flexDirection: "row", gap: 16 }}>
        <Image src={runtimeImage} placeholder={runtimeImage} blurRadius={blur() ? 3 : 0} fadeDuration={300} style={{ objectFit: "contain", width: 80, height: 64, backgroundColor: p.page }} />
        <View style={{ flex: 1, justifyContent: "center", gap: 16 }}>
          <Label color={p.muted}>NSH runtime</Label>
          <Action testID="effects-blur" label={blur() ? "Sharpen" : "Soften"} active={blur()} onPress={() => blur.set(!blur())} />
        </View>
      </View>
      <If when={windowSize().height >= 640}>
        <View><Label strong color={p.ink}>Canvas lettering</Label><Label color={p.faint}>Pacifico / bundled font</Label></View>
        <Canvas
          testID="font-sample"
          style={{ height: 64, backgroundColor: p.page }}
          draw={(ctx, { width, height }) => {
            const tint = ctx.createLinearGradient(0, 0, width, height);
            tint.addColorStop(0, p.mint); tint.addColorStop(1, p.blue);
            ctx.font = `32px "${Pacifico}"`;
            ctx.fillStyle = tint;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("Native Shell", width / 2, height / 2, width - 16);
          }}
        />
      </If>
    </View>
  );
}

function runbook(name: string, region: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Service runbook</title>
    <style>body{margin:8px;background:#101c28;color:#dfebf4;font:14px/20px system-ui}h1,h2{font-size:16px;color:#8bd6bd}ol,ul{padding-left:20px}</style></head>
    <body><h1>${name}</h1><p>Production / ${region}</p><h2>Rollout checklist</h2>
    <ol><li>Check the error budget.</li><li>Deploy one canary.</li><li>Watch latency for 5 minutes.</li><li>Continue after checks pass.</li></ol>
    <h2>Recovery</h2><p>Pause if latency rises.</p><p>Restore the last good build.</p><p>Notify the on-call owner.</p>
    <h2>On-call notes</h2><p>Keep a replica in each zone.</p><p>交接记录：先验证，再发布。</p></body></html>`;
}

/** A local runbook uses the existing WebView surface and navigation events. */
export function RunbookInspector(props: { name: string; region: string }) {
  const state = signal("Opening runbook");
  let reader: WebViewRef | undefined;
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 16 }}>
      <View style={{ height: 16, flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Label strong color={p.ink}>Service runbook</Label></View>
        <Action testID="runbook-reload" label="Reload" onPress={() => reader?.reload()} />
      </View>
      <WebView
        ref={reader}
        testID="service-runbook"
        accessibilityLabel="Service runbook"
        html={runbook(props.name, props.region)}
        javaScriptEnabled={false}
        onLoad={() => state.set("Runbook ready")}
        onError={() => state.set("Runbook load error")}
        style={{ flex: 1, minHeight: 160, backgroundColor: p.sidebar }}
      />
      <Label color={p.faint}>{state()}</Label>
    </View>
  );
}
