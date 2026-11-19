// A color picker's parts as the gallery draws them (`nsh/base`'s
// `ColorPicker`, `ColorArea`, `ColorSlider`, `ColorField`, `ColorSwatch`,
// `ColorEyeDropper`). The arrangement follows ReUI's color picker: the
// saturation and brightness area; the eyedropper, the hue and opacity
// sliders and a copy button on one row; the format's fields joined in one
// well, led by a menu of the formats; a row of preset swatches; and, in a
// popover, an outline trigger with the color's chip, its value and a
// chevron. Every look is the gallery's own: the fields' well, the icon
// buttons, the menus, the popover surface, the date picker's outline
// trigger, `radius.control` and the theme's tokens.
import type { InputStyle, JSX, ViewStyle } from "nsh";
import { Clipboard, platform, signal, Text, token, View } from "nsh";
import { Button as BaseButton, type ColorChannel, ColorArea, ColorEyeDropper, ColorField, type ColorFormat, ColorPicker, ColorSlider, type ColorSpace, ColorSwatch, Menu, MenuItem, Popover } from "nsh/base";
import { Icon } from "../icons";
import { MenuMark, menuIndicator, PopIn } from "../popup";
import { colors, hovered, radius, terminal, TERMINAL_COLUMN, TERMINAL_ROW } from "../theme";
import { iconButtonLook } from "./button";
import { fieldLook, fieldSize, fieldText } from "./field";
import { popoverLook } from "./overlay";
import { Picker } from "./listbox";
import { formatColor, inkOn } from "../color-format";
import { menuItemLabel, menuItemLook, menuItemNote, menuItemSize, menuPopup } from "./menu";

const pointer = platform.desktop;

/** The thumbs' side and the sliders' tracks' height: 16 and 12 with a pointer, 22 and 14 on a touch screen. */
const THUMB = pointer ? 16 : 22;
const TRACK = pointer ? 12 : 14;

/**
 * A thumb: the color in a white ring with a hairline outline and a small shadow, so it shows on any color under it
 * (a color the user picks, not the theme's, so the ring is white in either appearance).
 */
const thumbClass = "rounded-full border-2 border-white ring-1 ring-black/15 shadow-sm";
const thumbStyle = { width: THUMB, height: THUMB };

/** A hairline inside the edge of a field of colors, so the area's white corner and a track's light end show on the card. */
const EDGE = "border border-foreground/10";

/**
 * The area's hairline: a frame laid over the colors. A border of the panel itself would show the hue under it (the
 * panel's own fill is the hue, its gradients lie inside the border), a saturated line round a white or black corner.
 */
function AreaEdge() {
  return terminal ? null : (
    <View
      class="absolute inset-0 border border-foreground/10"
      style={{ pointerEvents: "none", borderRadius: radius.control }}
    />
  );
}

/**
 * The checkerboard under translucent colors, in the theme's tokens: the muted fill's squares over the page color
 * (spread it on an alpha `ColorSlider` or a `ColorSwatch`).
 */
export function colorChecker() {
  return {
    get checkerboardColor(): string {
      return token("muted");
    },
    checkerboardSize: 4,
  };
}

/** The saturation and brightness area's props (`<ColorArea {...colorAreaLook()} />`): 160 high with a pointer, the thumb filled with the color. A terminal's is eight rows of Cells. */
export function colorAreaLook() {
  if (terminal) return { style: { height: 8 * TERMINAL_ROW } };
  return {
    style: { height: pointer ? 160 : 192 },
    get panelStyle(): ViewStyle {
      return { borderRadius: radius.control };
    },
    thumbClass,
    thumbStyle,
    fillThumb: true,
  };
}

/**
 * A `ColorSlider`'s props: a round track (`alpha`: over the checkerboard), half a thumb free at each end so the thumb
 * stays inside, the thumb filled with the color; `style` goes on the slider (`{ flex: 1 }` in a row). A terminal's
 * slider is one row of its colors.
 */
export function colorSliderLook(o?: { alpha?: boolean; style?: ViewStyle }) {
  if (terminal) return o?.style ? { style: o.style } : {};
  const checker = colorChecker();
  return {
    style: { height: THUMB, justifyContent: "center", paddingHorizontal: THUMB / 2, ...o?.style } as ViewStyle,
    trackClass: `rounded-full ${EDGE}${o?.alpha ? " bg-background" : ""}`,
    trackStyle: { height: TRACK },
    thumbClass,
    thumbStyle,
    fillThumb: true,
    ...(o?.alpha ? { get checkerboardColor() { return checker.checkerboardColor; }, checkerboardSize: checker.checkerboardSize } : {}),
  };
}

/** The formats the fields' menu offers, as their menu names them. */
export const colorFormats: readonly { value: ColorFormat; label: string }[] = [
  { value: "hex", label: "HEX" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
  { value: "hsb", label: "HSB" },
  { value: "oklch", label: "OKLCH" },
];

/** The fields of a format: the whole color for hex, else the channels of its space. */
const FORMAT_FIELDS: Record<ColorFormat, { space: ColorSpace; channels: { channel: ColorChannel; name: string }[] } | null> = {
  hex: null,
  rgb: { space: "rgb", channels: [{ channel: "red", name: "Red" }, { channel: "green", name: "Green" }, { channel: "blue", name: "Blue" }] },
  hsl: { space: "hsl", channels: [{ channel: "hue", name: "Hue" }, { channel: "saturation", name: "Saturation" }, { channel: "lightness", name: "Lightness" }] },
  hsb: { space: "hsb", channels: [{ channel: "hue", name: "Hue" }, { channel: "saturation", name: "Saturation" }, { channel: "brightness", name: "Brightness" }] },
  oklch: { space: "oklch", channels: [{ channel: "lightness", name: "Lightness" }, { channel: "chroma", name: "Chroma" }, { channel: "hue", name: "Hue" }] },
};

/** A rule between two of the joined fields: the field's inner line, a Cell of room in a terminal. */
function Divider() {
  return <View style={terminal ? { width: TERMINAL_COLUMN } : { width: 1, backgroundColor: colors.line }} />;
}

/** A joined field's text: the field's size and colors, no well of its own (the group is the well), tabular figures. */
function joinedText(o?: { width?: number }): InputStyle {
  const { height: _height, flex: _flex, ...text } = fieldText();
  return {
    ...text,
    ...(o?.width ? { width: o.width } : { flex: 1 }),
    minWidth: 0,
    alignSelf: "stretch",
    paddingLeft: terminal ? 0 : 8,
    paddingRight: terminal ? 0 : 4,
    fontVariant: ["tabular-nums"],
  } as InputStyle;
}

/** The format menu's button inside the fields' well: a quiet button, its name and a chevron. */
function FormatButton(props: { label: string }) {
  return (
    <View
      hoverStyle={terminal ? undefined : hovered()}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "center",
        gap: 2,
        height: terminal ? TERMINAL_ROW : fieldSize.height - 10,
        marginLeft: terminal ? 0 : 4,
        marginRight: terminal ? TERMINAL_COLUMN : 4,
        paddingHorizontal: terminal ? 0 : 6,
        borderRadius: Math.max(radius.control - 3, 2),
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.text }}>{terminal ? `${props.label} ▾` : props.label}</Text>
      <Icon name="chevron-down" size={12} tint={colors.muted} />
    </View>
  );
}

/** Props of `ColorFields`. */
export interface ColorFieldsProps {
  /** The color as the picker last reported it (`#rrggbbaa`): the menu's previews. */
  value: string;
  /** What the fields' labels start with ("Fill color"): screen readers hear "Fill color hex", "Fill color red value". */
  name: string;
  format: ColorFormat;
  onFormatChange: (format: ColorFormat) => void;
  /** A field of the opacity at the end, in percent. */
  alpha?: boolean;
}

/**
 * The color's fields joined in one field's well (`fieldLook`): a menu of the formats first, then the hex field or the
 * channels of the format's space, then the opacity, parted by the field's inner line. Each item of the menu shows the
 * color in its format.
 */
export function ColorFields(props: ColorFieldsProps) {
  const fields = () => FORMAT_FIELDS[props.format];
  const label = () => colorFormats.find((f) => f.value === props.format)!.label;
  return (
    <View {...fieldLook({ style: { height: fieldSize.height, alignItems: "stretch", overflow: terminal ? undefined : "hidden" } })}>
      <Menu
        align="start"
        offset={4}
        margin={8}
        // As wide as the longest preview (an HSL with its opacity), which it grows past rather than cutting one short.
        {...menuPopup({ minWidth: 264 })}
        // The menu's root holds the trigger in a column: centered down the well's height, level with the fields' text.
        style={{ justifyContent: "center" }}
        trigger={
          <View accessibilityLabel={`${props.name} format, ${label()}`}>
            <FormatButton label={label()} />
          </View>
        }
      >
        {colorFormats.map((f) => (
          <MenuItem
            checked={props.format === f.value}
            role="menuitemradio"
            onSelect={() => props.onFormatChange(f.value)}
            indicatorClass={menuIndicator}
            indicator={<MenuMark kind="dot" size={menuItemSize.icon} tint={colors.accent} />}
            {...menuItemLook()}
          >
            <Text style={{ ...menuItemLabel(), flexGrow: 0, width: 52 }}>{f.label}</Text>
            {/* Whole, never ellipsized: the row (and the menu) takes its width. */}
            <Text style={{ ...menuItemNote(), flexShrink: 0, fontVariant: ["tabular-nums"] }}>{formatColor(props.value, f.value).replace(/^\w+\(|\)$/g, "")}</Text>
          </MenuItem>
        ))}
      </Menu>
      <Divider />
      {() => {
        const f = fields();
        if (!f) return <ColorField format="hex" accessibilityLabel={`${props.name} hex`} style={joinedText()} />;
        return f.channels.map((c, i) => (
          <>
            {i > 0 ? <Divider /> : null}
            <ColorField colorSpace={f.space} channel={c.channel} accessibilityLabel={`${props.name} ${c.name.toLowerCase()} value`} style={joinedText()} />
          </>
        ));
      }}
      {props.alpha ? (
        <>
          <Divider />
          <ColorField
            channel="alpha"
            accessibilityLabel={`${props.name} opacity value`}
            // Right-aligned against its suffix, as a number before its unit (a class: the field's style is a view's).
            class="text-right"
            style={{ ...joinedText({ width: terminal ? 3 * TERMINAL_COLUMN : 40 }), paddingRight: 0 }}
          />
          {/* Percent, as a field's suffix: quiet text inside the well after the number. */}
          <Text style={{ alignSelf: "center", paddingLeft: terminal ? 0 : 2, paddingRight: terminal ? 0 : 8, fontSize: fieldSize.font, color: colors.muted }}>%</Text>
        </>
      ) : null}
    </View>
  );
}

/** A copy button (the gallery's ghost icon button): it copies `text()` and shows a check for a moment. */
export function ColorCopy(props: { name: string; text: () => string }) {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (
    <BaseButton
      accessibilityLabel={copied() ? "Copied" : `Copy ${props.name.toLowerCase()}`}
      onPress={() => {
        void Clipboard.writeText(props.text());
        copied.set(true);
        clearTimeout(timer);
        timer = setTimeout(() => copied.set(false), 1500);
      }}
      {...iconButtonLook()}
    >
      {terminal ? <Text style={{ color: colors.muted }}>{copied() ? "✓" : "Copy"}</Text> : <Icon name={copied() ? "check" : "copy"} size={16} tint={copied() ? colors.accent : colors.muted} />}
    </BaseButton>
  );
}

/** The system's eyedropper as the gallery's ghost icon button; hidden where the platform has none. */
export function ColorDropper(props: { name: string }) {
  return (
    <ColorEyeDropper accessibilityLabel={`Pick ${props.name.toLowerCase()} from the screen`} {...iconButtonLook()} class="disabled:hidden">
      {terminal ? <Text style={{ color: colors.muted }}>Pick</Text> : <Icon name="pipette" size={16} tint={colors.muted} />}
    </ColorEyeDropper>
  );
}

/**
 * Preset swatches in a row, spread to its width: 24-point chips with the control's radius less one and a hairline
 * edge, grown under the pointer; the picker's color shows a check in an ink that reads on it. A terminal's are two
 * Cells by a row.
 */
export function ColorSwatches(props: { colors: readonly string[] }) {
  const checker = colorChecker();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: terminal ? "flex-start" : "space-between", columnGap: terminal ? TERMINAL_COLUMN : 4, rowGap: 6 }}>
      {props.colors.map((c) => (
        <ColorSwatch
          color={c}
          class={terminal ? undefined : `group items-center justify-center ${EDGE} bg-background transition-transform duration-150 hover:scale-110 motion-reduce:transition-none`}
          style={terminal ? { width: 2 * TERMINAL_COLUMN, height: TERMINAL_ROW } : { width: 24, height: 24, borderRadius: Math.max(radius.control - 1, 2) }}
          checkerboardColor={checker.checkerboardColor}
          checkerboardSize={checker.checkerboardSize}
        >
          {terminal ? null : (
            <View class="hidden group-selected:flex">
              <Icon name="check" size={14} tint={inkOn(c)} />
            </View>
          )}
        </ColorSwatch>
      ))}
    </View>
  );
}

/** Props of `ColorPanel`. */
export interface ColorPanelProps extends ColorFieldsProps {
  /** Preset swatches under the fields. */
  swatches?: readonly string[];
}

/**
 * The whole picker in place (inside a `ColorPicker`, or a popover in one): the area; the eyedropper, the hue slider
 * (and the opacity's, `alpha`) and the copy button on one row; the joined fields; the swatches. Its parts are named
 * after `name` for screen readers.
 */
export function ColorPanel(props: ColorPanelProps) {
  return (
    <View style={{ gap: terminal ? TERMINAL_ROW : 10 }}>
      <View>
        <ColorArea accessibilityLabel={`${props.name} saturation and brightness`} {...colorAreaLook()} />
        <AreaEdge />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: terminal ? TERMINAL_COLUMN : 8 }}>
        <ColorDropper name={props.name} />
        <View style={{ flex: 1, minWidth: 0, gap: terminal ? 0 : 8 }}>
          <ColorSlider colorSpace="hsb" channel="hue" accessibilityLabel={`${props.name} hue`} {...colorSliderLook()} />
          {props.alpha ? <ColorSlider channel="alpha" accessibilityLabel={`${props.name} opacity`} {...colorSliderLook({ alpha: true })} /> : null}
        </View>
        <ColorCopy name={props.name} text={() => formatColor(props.value, props.format)} />
      </View>
      <ColorFields value={props.value} name={props.name} format={props.format} onFormatChange={props.onFormatChange} alpha={props.alpha} />
      {props.swatches ? <ColorSwatches colors={props.swatches} /> : null}
    </View>
  );
}

/**
 * A picker's trigger in a popover: a field, as a select's and a date picker's (`Picker`), led by the picker's
 * color as a chip (a `ColorSwatch` with no color, over the checkerboard), the value as text and the chevron.
 */
export function ColorTrigger(props: { open: boolean; value: string; style?: ViewStyle }): JSX.Element {
  const checker = colorChecker();
  return (
    <Picker
      title={props.value}
      open={props.open}
      style={props.style}
      lead={
        <ColorSwatch
          class={terminal ? undefined : `${EDGE} bg-background`}
          style={terminal ? { width: 2 * TERMINAL_COLUMN, height: TERMINAL_ROW } : { width: 16, height: 16, borderRadius: 4 }}
          checkerboardColor={checker.checkerboardColor}
          checkerboardSize={checker.checkerboardSize}
        />
      }
    />
  );
}

/** Props of `ColorPopover`. */
export interface ColorPopoverProps {
  /** What screen readers call the trigger and the panel's parts; the trigger reads `<name>, <value>`. */
  name: string;
  /** The color, `#rrggbbaa`, as the picker reports it. */
  value: string;
  /** The format the fields, the trigger and `onChangeEnd`'s text use. */
  format: ColorFormat;
  /** The opacity too: its slider and field, and a wider popover for the field. */
  alpha?: boolean;
  /** The trigger's style (its width). */
  style?: ViewStyle;
  onChange: (value: string) => void;
  onFormatChange: (format: ColorFormat) => void;
  onChangeEnd?: (formatted: string) => void;
}

/**
 * A picker opened from a field's trigger: `ColorTrigger` shows the color and its value in the fields' format, the
 * popover (the gallery's popover surface, popping in under the trigger) the whole `ColorPanel`.
 */
export function ColorPopover(props: ColorPopoverProps): JSX.Element {
  const open = signal(false);
  return (
    <ColorPicker
      value={props.value}
      format={props.format}
      onChange={({ value }) => props.onChange(value)}
      onChangeEnd={({ formatted }) => props.onChangeEnd?.(formatted)}
    >
      <Popover
        placement="bottom"
        align="start"
        offset={4}
        margin={8}
        onOpenChange={({ open: next }) => open.set(next)}
        trigger={
          <View accessibilityLabel={`${props.name}, ${formatColor(props.value, props.format)}`}>
            <ColorTrigger open={open()} value={formatColor(props.value, props.format)} style={props.style} />
          </View>
        }
      >
        <PopIn side="bottom" style={popoverLook({ width: props.alpha ? 320 : 288 })}>
          <ColorPanel name={props.name} value={props.value} format={props.format} onFormatChange={props.onFormatChange} alpha={props.alpha} />
        </PopIn>
      </Popover>
    </ColorPicker>
  );
}
