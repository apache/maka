<script setup lang="ts">
// rolldown-vite 的 SFC 编译环境不提供跨文件类型解析所需 fs，外部类型需内联（shadcn-vue 生成件，本仓库内固定）
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { Primitive } from "reka-ui";
import { cn } from "@/lib/utils";
import { badgeVariants } from ".";

const props = defineProps<{
  asChild?: boolean;
  as?: unknown;
  variant?: "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
  class?: HTMLAttributes["class"];
}>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <Primitive
    data-slot="badge"
    :data-variant="variant"
    :class="cn(badgeVariants({ variant }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
