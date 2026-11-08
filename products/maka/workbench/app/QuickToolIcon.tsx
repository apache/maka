/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { View, Image } from "nsh";
import { Icon } from "./Icon";
import { C } from "./ui";
const pluginGlyph = (
  id = "",
  icon = "",
): Parameters<typeof Icon>[0]["name"] => {
  const kind = `${id} ${icon}`;
  if (/assistant|suggestions/.test(kind)) return "thinking";
  if (/quicklink|link/.test(kind)) return "paperclip";
  if (/clipboard/.test(kind)) return "copy";
  if (/notes|snippet/.test(kind)) return "file";
  if (/files/.test(kind)) return "folder";
  if (/calculator/.test(kind)) return "code";
  if (/chrome|browser/.test(kind)) return "sidebar";
  if (/screenshot/.test(kind)) return "image";
  if (/bilibili/.test(kind)) return "play";
  if (/symbols/.test(kind)) return "plus";
  if (/application/.test(kind)) return "split";
  return "command";
};
export const toolIcon = (icon?: string, id?: string, compact = false) => (
  <View
    style={{
      width: compact ? 20 : 32,
      height: compact ? 20 : 32,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    }}
  >
    <If
      when={icon?.startsWith("data:image/png;base64,")}
      else={
        <Icon
          size={compact ? 18 : undefined}
          name={pluginGlyph(id, icon)}
          color={C.secondary}
        />
      }
    >
      <Image
        src={icon ?? ""}
        style={{ width: compact ? 18 : 26, height: compact ? 18 : 26 }}
      />
    </If>
  </View>
);
