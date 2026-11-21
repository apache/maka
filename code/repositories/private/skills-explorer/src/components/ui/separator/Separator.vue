<script setup lang="ts">
// 外部类型内联（rolldown-vite 编译环境限制，见 Badge.vue 注释）
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { Separator } from "reka-ui";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    asChild?: boolean;
    as?: unknown;
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  {
    orientation: "horizontal",
    decorative: true,
  },
);

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <Separator
    data-slot="separator"
    v-bind="delegatedProps"
    :class="
      cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
        props.class,
      )
    "
  />
</template>
