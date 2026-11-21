<script setup lang="ts">
// 外部类型内联（rolldown-vite 编译环境限制，见 Badge.vue 注释）
import type { HTMLAttributes } from "vue";
import { CheckIcon } from "@lucide/vue";
import { reactiveOmit } from "@vueuse/core";
import { CheckboxIndicator, CheckboxRoot, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<{
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean | "indeterminate";
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: unknown;
  asChild?: boolean;
  as?: unknown;
  class?: HTMLAttributes["class"];
}>();
const emits = defineEmits<{
  (e: "update:checked", value: boolean | "indeterminate"): void;
}>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <CheckboxRoot
    v-slot="slotProps"
    data-slot="checkbox"
    v-bind="forwarded"
    :class="
      cn(
        'border-input dark:bg-input/30 data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary data-checked:border-primary aria-invalid:aria-checked:border-primary aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 flex size-4 items-center justify-center rounded-[4px] border transition-colors group-has-disabled/field:opacity-50 focus-visible:ring-3 aria-invalid:ring-3 peer relative shrink-0 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  >
    <CheckboxIndicator
      data-slot="checkbox-indicator"
      class="[&>svg]:size-3.5 grid place-content-center text-current transition-none"
    >
      <slot v-bind="slotProps">
        <CheckIcon />
      </slot>
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
