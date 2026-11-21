<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";

import { Badge } from "@/components/ui/badge";
import { useSkillsStore } from "@/stores/skills";

const store = useSkillsStore();
store.load();

const navLink =
  "hover:bg-accent rounded-md px-3 py-1.5 outline-offset-4 focus-visible:outline-ring focus-visible:outline-2";
const navActive = "bg-accent text-foreground font-medium";
</script>

<template>
  <div class="bg-background text-foreground flex min-h-screen flex-col">
    <a
      href="#main"
      class="bg-primary text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-1.5 focus:text-sm"
    >
      跳到主要内容
    </a>
    <header
      class="bg-card/80 supports-[backdrop-filter]:bg-card/60 sticky top-0 z-20 border-b backdrop-blur"
    >
      <div class="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4">
        <RouterLink to="/" class="flex items-center gap-2 font-semibold">
          <span
            class="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md text-xs"
            aria-hidden="true"
            >SE</span
          >
          <span>Skills Explorer</span>
        </RouterLink>
        <nav class="flex items-center gap-1 text-sm" aria-label="站点导航">
          <RouterLink
            to="/"
            :class="navLink"
            exact-active-class="bg-accent text-foreground font-medium"
            >浏览</RouterLink
          >
          <RouterLink
            to="/stats"
            :class="navLink"
            active-class="bg-accent text-foreground font-medium"
            >统计</RouterLink
          >
          <RouterLink
            to="/collections"
            :class="navLink"
            active-class="bg-accent text-foreground font-medium"
            >收藏</RouterLink
          >
        </nav>
        <Badge v-if="store.index" variant="secondary" class="ml-auto font-mono">
          {{ store.index.total }} skills
        </Badge>
      </div>
    </header>
    <main id="main" class="mx-auto w-full max-w-7xl flex-1 px-4 py-6" tabindex="-1">
      <div
        v-if="store.error"
        class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm"
        role="alert"
      >
        索引加载失败：{{ store.error }}
      </div>
      <RouterView v-else />
    </main>
  </div>
</template>
