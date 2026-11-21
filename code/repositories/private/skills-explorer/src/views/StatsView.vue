<script setup lang="ts">
import { computed, onMounted } from "vue";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSkillsStore } from "@/stores/skills";

const store = useSkillsStore();
onMounted(() => store.load());

const maxPool = computed(() => store.poolBySource[0]?.[1] ?? 1);
const maxCat = computed(() => store.curatedByCategory[0]?.[1] ?? 1);
const generatedAt = computed(() =>
  store.index ? new Date(store.index.generatedAt).toLocaleString("zh-CN") : "",
);
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="mb-1 text-xl font-semibold">技能库统计</h1>
      <p class="text-muted-foreground text-sm">
        索引生成于 {{ generatedAt }} · 数据源 ~/.ai/categories
      </p>
    </div>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Card v-for="zone in ['curated', 'pool', 'archive'] as const" :key="zone">
        <CardHeader class="pb-2">
          <CardTitle class="text-muted-foreground text-sm font-medium">
            {{ zone === "curated" ? "精选分类" : zone === "pool" ? "候选池" : "归档淘汰" }}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div class="font-mono text-3xl font-semibold">{{ store.zoneCounts[zone] }}</div>
        </CardContent>
      </Card>
    </div>

    <section>
      <h2 class="mb-3 text-base font-semibold">精选区 · 顶层分类分布</h2>
      <div class="space-y-2">
        <div
          v-for="[cat, count] in store.curatedByCategory"
          :key="cat"
          class="flex items-center gap-3 text-sm"
        >
          <span class="w-56 shrink-0 truncate">{{ cat }}</span>
          <div class="bg-muted h-5 flex-1 overflow-hidden rounded-sm">
            <div class="bg-primary h-full" :style="{ width: (count / maxCat) * 100 + '%' }" />
          </div>
          <Badge variant="secondary" class="shrink-0 font-mono">{{ count }}</Badge>
        </div>
      </div>
    </section>

    <section>
      <h2 class="mb-1 text-base font-semibold">候选池 · 来源仓库 Top 20</h2>
      <p class="text-muted-foreground mb-3 text-sm">
        共 {{ store.poolBySource.length }} 个来源仓库
      </p>
      <div class="space-y-2">
        <div
          v-for="[src, count] in store.poolBySource.slice(0, 20)"
          :key="src"
          class="flex items-center gap-3 text-sm"
        >
          <span class="w-56 shrink-0 truncate font-mono text-xs" :title="src">{{ src }}</span>
          <div class="bg-muted h-5 flex-1 overflow-hidden rounded-sm">
            <div class="bg-primary/70 h-full" :style="{ width: (count / maxPool) * 100 + '%' }" />
          </div>
          <Badge variant="secondary" class="shrink-0 font-mono">{{ count }}</Badge>
        </div>
      </div>
    </section>
  </div>
</template>
