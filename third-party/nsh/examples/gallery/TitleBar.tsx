import { type JSX, Text, View } from "nsh";
import { TitleBar as WindowTitleBar } from "nsh/base";
import { isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { colors, Logo, terminal } from "./ui";

/** App-drawn window chrome; the platform keeps its native window controls,
 * which the bar keeps clear of. `leading` goes right after the logo (the
 * sidebar's toggle). A terminal program has no window chrome: none there. */
export function TitleBar(props: { leading?: JSX.Element }) {
  return (
    <If when={hasWindow && !terminal}>
      <WindowTitleBar style={{ backgroundColor: colors.inset, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <View
          style={{
            flex: 1,
            height: titleBar().height || 40,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 12,
          }}
        >
          <Logo size={20} />
          {props.leading}
          <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>Gallery</Text>
          <Text style={{ fontSize: 11, color: colors.muted }}>NSH</Text>
        </View>
      </WindowTitleBar>
    </If>
  );
}
