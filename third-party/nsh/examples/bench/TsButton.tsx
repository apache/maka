// A Button written in TSX (as NSH's own was before components moved into
// Rust, commit 8ac6eb7), drawn exactly like the benchmark's Rust Button with
// the default theme: the baseline of the component benchmarks.

import type { JSX, StyleProp, ViewStyle } from "nsh";
import { Text, View } from "nsh";

export interface ButtonProps {
  /** The label. */
  title: string;
  onPress?: () => void;
  /** `primary` (default): filled; `secondary`: tinted; `danger`: destructive; `plain`: text only. */
  variant?: "primary" | "secondary" | "danger" | "plain";
  /** No presses, no feedback, dimmed. */
  disabled?: boolean;
  /** Classes appended to the button's own: they win over them. */
  class?: string;
  style?: StyleProp<ViewStyle>;
  /** For screen readers, when `title` is not enough. */
  accessibilityLabel?: string;
  testID?: string;
}

const base = "flex-row items-center justify-center rounded-xl px-4 py-3 disabled:opacity-50";

// The default theme's colors (`nsh_core::element::Theme`).
const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-neutral-900 active:bg-neutral-950 text-neutral-50 dark:bg-neutral-50 dark:active:bg-neutral-200 dark:text-neutral-900",
  secondary:
    "bg-neutral-200 active:bg-neutral-300 text-neutral-900 dark:bg-neutral-800 dark:active:bg-[#212121] dark:text-neutral-50",
  danger: "bg-red-500 active:bg-red-600 text-neutral-50 dark:bg-red-400 dark:active:bg-red-500 dark:text-red-600",
  plain: "active:bg-neutral-100 text-neutral-950 dark:active:bg-neutral-800 dark:text-neutral-50",
};

/** A button drawn with nsh's primitives: the feedback is native (`active:`),
 * the label inherits the button's text classes. */
export function Button(props: ButtonProps): JSX.Element {
  return (
    <View
      onPress={() => props.onPress?.()}
      disabled={props.disabled}
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityState={{ disabled: !!props.disabled }}
      testID={props.testID}
      class={`${base} ${variants[props.variant ?? "primary"]} ${props.class ?? ""}`}
      style={props.style}
    >
      <Text class="text-[16px] font-semibold">{props.title}</Text>
    </View>
  );
}
