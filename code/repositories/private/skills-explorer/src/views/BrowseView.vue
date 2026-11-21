<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import SkillCard from "@/components/SkillCard.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ZONE_LABEL, type SkillZone } from "@/lib/schemas";
import { PAGE_SIZE, useSkillsStore } from "@/stores/skills";

const store = useSkillsStore();
const route = useRoute();
const router = useRouter();
onMounted(() => {
  // 从 URL 恢复筛选状态（deep-link：筛选视图可分享、刷新不丢）
  const q = route.query;
  if (q.q) store.query = String(q.q);
  if (q.cat) store.categoryPath = String(q.cat);
  if (q.sort === "name" || q.sort === "category") store.sortMode = q.sort;
  if (q.zones) {
    const z = String(q.zones).split(",");
    store.zoneVisible = {
      curated: z.includes("curated"),
      pool: z.includes("pool"),
      archive: z.includes("archive"),
    };
  }
  store.load();
});

const ZONES: SkillZone[] = ["curated", "pool", "archive"];
const visibleSkills = computed(() => store.filtered.slice(0, store.visibleCount));
const remaining = computed(() => store.filtered.length - visibleSkills.value.length);

// 筛选变化 → replace 到 query（不产生历史记录）；默认态收干净参数
watch(
  [() => store.query, () => store.categoryPath, () => store.sortMode, () => store.zoneVisible],
  () => {
    const zones = ZONES.filter((z) => store.zoneVisible[z]).join(",");
    router
      .replace({
        query: {
          ...(store.query ? { q: store.query } : {}),
          ...(store.categoryPath ? { cat: store.categoryPath } : {}),
          ...(store.sortMode !== "category" ? { sort: store.sortMode } : {}),
          ...(zones && zones !== "curated" ? { zones } : {}),
        },
      })
      .catch(() => {});
    store.visibleCount = PAGE_SIZE;
  },
  { deep: true },
);

const chipBase =
  "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs transition-colors focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2";
</script>

<template>
  <div class="space-y-6">
    <!-- 头部：总量与统计 -->
    <section class="pt-2 text-center">
      <h1 class="text-2xl font-semibold tracking-tight text-balance">
        {{ store.index?.total ?? "…" }} 个 Skill，总有一个顺手
      </h1>
      <p class="text-muted-foreground mt-1.5 text-sm">
        本机
        <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">~/.ai/categories</code>
        技能库的可视化目录：先看用途，再进详情，装上就用。
      </p>
      <div
        v-if="store.index"
        class="text-muted-foreground mt-3 flex items-center justify-center gap-5 text-sm"
      >
        <span
          >分类
          <strong class="text-foreground font-mono">{{
            store.index.categories.length
          }}</strong></span
        >
        <span aria-hidden="true" class="bg-border h-3 w-px"></span>
        <span
          >Skill <strong class="text-foreground font-mono">{{ store.index.total }}</strong></span
        >
        <span aria-hidden="true" class="bg-border h-3 w-px"></span>
        <span
          >来源仓库
          <strong class="text-foreground font-mono">{{ store.poolBySource.length }}</strong></span
        >
      </div>
    </section>

    <!-- 筛选区：搜索 + 区域开关 + 排序 -->
    <section
      class="bg-card/60 supports-[backdrop-filter]:bg-card/60 sticky top-14 z-10 -mx-4 border-y px-4 py-3 backdrop-blur"
    >
      <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
        <Input
          v-model="store.query"
          type="search"
          placeholder="搜索 Skill…"
          aria-label="搜索技能"
          class="h-9 max-w-xs flex-1"
        />
        <div class="flex items-center gap-1" role="group" aria-label="按区域筛选">
          <Button
            v-for="zone in ZONES"
            :key="zone"
            :variant="store.zoneVisible[zone] ? 'default' : 'outline'"
            size="sm"
            class="h-9"
            :aria-pressed="store.zoneVisible[zone]"
            @click="store.toggleZone(zone)"
          >
            {{ ZONE_LABEL[zone] }}
            <span class="ml-1 font-mono text-xs opacity-70">{{ store.zoneCounts[zone] }}</span>
          </Button>
        </div>
        <select
          v-model="store.sortMode"
          class="border-input bg-background h-9 rounded-md border px-2 text-sm"
          aria-label="排序方式"
        >
          <option value="category">按分类</option>
          <option value="name">按名称</option>
        </select>
      </div>
      <!-- 分类 chips -->
      <div class="mx-auto mt-2 flex max-w-5xl flex-wrap items-center gap-1.5">
        <button
          :class="[
            chipBase,
            store.categoryPath === null
              ? 'bg-primary text-primary-foreground border-primary font-medium'
              : 'bg-background hover:border-ring hover:text-foreground',
          ]"
          :aria-pressed="store.categoryPath === null"
          @click="store.pickCategory(null)"
        >
          全部 <span class="font-mono opacity-70">{{ store.zoneVisibleTotal }}</span>
        </button>
        <button
          v-for="chip in store.categoryChips"
          :key="chip.path"
          :class="[
            chipBase,
            store.categoryPath === chip.path
              ? 'bg-primary text-primary-foreground border-primary font-medium'
              : 'bg-background text-muted-foreground hover:border-ring hover:text-foreground',
          ]"
          :aria-pressed="store.categoryPath === chip.path"
          @click="store.pickCategory(chip.path)"
        >
          {{ chip.name }} <span class="font-mono opacity-70">{{ chip.count }}</span>
        </button>
      </div>
    </section>

    <!-- 结果列表 -->
    <section class="mx-auto max-w-5xl">
      <div
        v-if="store.loading && !store.index"
        class="grid grid-cols-1 gap-3 md:grid-cols-2"
        aria-label="加载中"
      >
        <Skeleton v-for="i in 6" :key="i" class="h-28 rounded-xl" />
      </div>
      <div
        v-else-if="store.error"
        class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm"
      >
        {{ store.error }}
      </div>
      <div
        v-else-if="store.filtered.length === 0"
        class="text-muted-foreground py-16 text-center text-sm"
      >
        <p>没有匹配的技能。</p>
        <p class="mt-2">
          <button
            class="text-primary underline underline-offset-4"
            @click="
              store.query = '';
              store.pickCategory(null);
            "
          >
            清空筛选
          </button>
          或打开上方「候选池」开关扩大范围。
        </p>
      </div>
      <template v-else>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <SkillCard v-for="s in visibleSkills" :key="s.id" :skill="s" />
        </div>
        <div v-if="remaining > 0" class="mt-6 text-center">
          <Button variant="outline" @click="store.visibleCount += PAGE_SIZE">
            再显示 {{ Math.min(PAGE_SIZE, remaining) }} 个
          </Button>
          <p class="text-muted-foreground mt-2 text-xs">
            {{ visibleSkills.length }} / {{ store.filtered.length }}
          </p>
        </div>
      </template>
    </section>
  </div>
</template>
