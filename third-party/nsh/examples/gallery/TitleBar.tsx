import { type JSX, Text, View } from "nsh";
import { isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { colors, Logo } from "./ui";

/** App-drawn window chrome; the platform keeps its native window controls.
 * `leading` goes right after the logo (the sidebar's toggle). */
export function TitleBar(props: { leading?: JSX.Element }) {
  return (
    <If when={hasWindow}>
      <View
        desktop={{ windowDrag: true }}
        style={{
          height: titleBar().height || 40,
          flexShrink: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: titleBar().left + 12,
          paddingRight: titleBar().right + 12,
          backgroundColor: colors.inset,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
        }}
      >
        <Logo size={20} />
        {props.leading}
        <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>Gallery</Text>
        <Text style={{ fontSize: 11, color: colors.muted }}>NSH</Text>
      </View>
    </If>
  );
}

