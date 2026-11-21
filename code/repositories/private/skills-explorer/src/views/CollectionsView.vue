<script setup lang="ts">
import { computed, onMounted } from "vue";

import SkillCard from "@/components/SkillCard.vue";
import type { SkillMeta } from "@/lib/schemas";
import { useFavoritesStore } from "@/stores/favorites";
import { useSkillsStore } from "@/stores/skills";

const store = useSkillsStore();
const favs = useFavoritesStore();
onMounted(() => store.load());

const items = computed<SkillMeta[]>(() => {
  if (!store.index) return [];
  const byId = new Map(store.index.skills.map((s) => [s.id, s]));
  return [...favs.ids].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
});
</script>

<template>
  <div>
    <h1 class="mb-1 text-xl font-semibold">我的收藏</h1>
    <p class="text-muted-foreground mb-4 text-sm">收藏保存在浏览器本地（localStorage）。</p>

    <div v-if="items.length === 0" class="text-muted-foreground py-16 text-center text-sm">
      还没有收藏，去<RouterLink to="/" class="text-primary mx-1 underline underline-offset-4"
        >浏览页</RouterLink
      >点亮星星吧。
    </div>
    <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <SkillCard v-for="s in items" :key="s.id" :skill="s" />
    </div>
  </div>
</template>
