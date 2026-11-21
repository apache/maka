import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { fetchSkillsIndex } from "@/api/skills";
import type { SkillMeta, SkillZone, SkillsIndex, Subcategory } from "@/lib/schemas";

export const PAGE_SIZE = 48;

export const useSkillsStore = defineStore("skills", () => {
  const index = ref<SkillsIndex | null>(null);
  const loading = ref(false);
  const error = ref("");

  const query = ref("");
  const categoryPath = ref<string | null>(null);
  const sortMode = ref<"name" | "category">("category");
  const visibleCount = ref(PAGE_SIZE);
  /** 区域可见性：精选默认展示，候选池/归档默认隐藏 */
  const zoneVisible = ref<Record<SkillZone, boolean>>({
    curated: true,
    pool: false,
    archive: false,
  });

  async function load() {
    if (index.value || loading.value) return;
    loading.value = true;
    error.value = "";
    try {
      index.value = await fetchSkillsIndex();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function toggleZone(zone: SkillZone) {
    zoneVisible.value = { ...zoneVisible.value, [zone]: !zoneVisible.value[zone] };
    visibleCount.value = PAGE_SIZE;
  }

  function pickCategory(path: string | null) {
    categoryPath.value = path;
    visibleCount.value = PAGE_SIZE;
  }

  const filtered = computed<SkillMeta[]>(() => {
    if (!index.value) return [];
    const q = query.value.trim().toLowerCase();
    const rows = index.value.skills.filter((s) => {
      if (!zoneVisible.value[s.zone]) return false;
      if (categoryPath.value && `${s.category}/${s.subcategory}` !== categoryPath.value)
        return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.subcategory.toLowerCase().includes(q)
      );
    });
    if (sortMode.value === "category") {
      return [...rows].sort(
        (a, b) =>
          a.zone.localeCompare(b.zone) ||
          a.category.localeCompare(b.category) ||
          a.subcategory.localeCompare(b.subcategory) ||
          a.name.localeCompare(b.name),
      );
    }
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** 分类 chips：按区域分组顺序，全部 + 每个子分类（带计数） */
  const categoryChips = computed<Subcategory[]>(() => {
    const zoneOrder: SkillZone[] = ["curated", "pool", "archive"];
    return (index.value?.categories ?? [])
      .filter((c) => zoneVisible.value[c.zone])
      .sort(
        (a, b) =>
          zoneOrder.indexOf(a.zone) - zoneOrder.indexOf(b.zone) || a.path.localeCompare(b.path),
      );
  });

  const zoneCounts = computed(() => {
    const counts = { curated: 0, pool: 0, archive: 0 } as Record<SkillZone, number>;
    for (const s of index.value?.skills ?? []) counts[s.zone]++;
    return counts;
  });

  /** 仅受区域开关影响的总数，供"全部"chip 展示 */
  const zoneVisibleTotal = computed(
    () => (index.value?.skills ?? []).filter((s) => zoneVisible.value[s.zone]).length,
  );

  /** 候选池按来源仓库聚合，统计页用 */
  const poolBySource = computed(() => {
    const map = new Map<string, number>();
    for (const s of index.value?.skills ?? []) {
      if (s.zone !== "pool" || !s.source) continue;
      map.set(s.source, (map.get(s.source) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  });

  /** 精选区按顶层分类聚合 */
  const curatedByCategory = computed(() => {
    const map = new Map<string, number>();
    for (const s of index.value?.skills ?? []) {
      if (s.zone !== "curated") continue;
      map.set(s.category, (map.get(s.category) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  });

  return {
    index,
    loading,
    error,
    query,
    categoryPath,
    sortMode,
    visibleCount,
    zoneVisible,
    filtered,
    categoryChips,
    zoneCounts,
    zoneVisibleTotal,
    poolBySource,
    curatedByCategory,
    load,
    toggleZone,
    pickCategory,
  };
});
