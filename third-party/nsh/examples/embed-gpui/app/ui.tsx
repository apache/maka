// The app's own controls, drawn with primitives and Tailwind classes; the
// `dark:` variants follow the host's light or dark mode
// (`AppView::set_appearance`).

import { type JSX, Text, View } from "nsh";
import { Input } from "nsh/base";

/** A press target with a label: `primary` (default) or `danger`. */
export function Button(props: { title: string; variant?: "primary" | "danger"; onPress?: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      class={
        props.variant === "danger"
          ? "items-center rounded-lg bg-red-600 px-4 py-3 active:bg-red-700"
          : "items-center rounded-lg bg-zinc-900 px-4 py-3 active:bg-zinc-700 dark:bg-zinc-100 dark:active:bg-zinc-300"
      }
    >
      <Text class={props.variant === "danger" ? "font-semibold text-white" : "font-semibold text-white dark:text-zinc-900"}>{props.title}</Text>
    </View>
  );
}

/** A rounded surface with an optional title over its content. */
export function Card(props: { title?: string; children: JSX.Element }) {
  return (
    <View class="gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <If when={props.title}>
        <Text class="text-[17px] font-semibold text-zinc-900 dark:text-zinc-100">{props.title}</Text>
      </If>
      {props.children}
    </View>
  );
}

/** A labeled text input. */
export function TextField(props: { label: string; value?: string; placeholder?: string; onChange?: (text: string) => void }) {
  return (
    <View class="gap-1">
      <Text class="text-sm text-zinc-500 dark:text-zinc-400">{props.label}</Text>
      <Input
        value={props.value}
        placeholder={props.placeholder}
        onChange={props.onChange}
        class="min-h-11 rounded-lg border border-zinc-300 px-3 text-base text-zinc-900 focus:border-blue-500 dark:border-zinc-700 dark:text-zinc-100"
      />
    </View>
  );
}

/** A number with − and + buttons, within `min`–`max`. */
export function Stepper(props: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  const step = (by: number) => props.onChange(Math.min(props.max, Math.max(props.min, props.value + by)));
  const button = (label: string, name: string, by: number) => (
    <View
      role="button"
      accessibilityLabel={name}
      onPress={() => step(by)}
      class="size-10 items-center justify-center rounded-lg bg-zinc-100 active:bg-zinc-200 dark:bg-zinc-800 dark:active:bg-zinc-700"
    >
      <Text class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{label}</Text>
    </View>
  );
  return (
    <View class="flex-row items-center gap-3">
      {button("−", "Decrease", -1)}
      <Text class="min-w-12 text-center font-medium text-zinc-900 dark:text-zinc-100">{`${props.value}`}</Text>
      {button("+", "Increase", 1)}
    </View>
  );
}
