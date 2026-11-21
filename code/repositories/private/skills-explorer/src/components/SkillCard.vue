<script setup lang="ts">
import { RouterLink } from "vue-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ZONE_LABEL, type SkillMeta } from "@/lib/schemas";
import { useFavoritesStore } from "@/stores/favorites";

const props = defineProps<{ skill: SkillMeta }>();
const favs = useFavoritesStore();

const ZONE_VARIANT = {
  curated: "default",
  pool: "secondary",
  archive: "outline",
} as const;
</script>

<template>
  <Card
    class="hover:border-ring hover:shadow-sm hover:-translate-y-0.5 h-full transition-[border-color,box-shadow,translate]"
  >
    <RouterLink
      :to="{ name: 'skill', params: { id: props.skill.id } }"
      class="focus-visible:outline-ring flex h-full flex-col rounded-xl p-4 outline-offset-2 focus-visible:outline-2"
    >
      <div class="mb-2 flex items-center gap-1.5">
        <Badge :variant="ZONE_VARIANT[props.skill.zone]">
          {{
            props.skill.zone === "curated" ? props.skill.subcategory : ZONE_LABEL[props.skill.zone]
          }}
        </Badge>
        <span
          v-if="props.skill.source"
          class="text-muted-foreground truncate font-mono text-xs"
          :title="props.skill.source"
        >
          {{ props.skill.source }}
        </span>
        <Button
          variant="ghost"
          size="icon"
          class="text-muted-foreground hover:text-foreground ml-auto size-7 shrink-0"
          :aria-label="
            favs.has(props.skill.id) ? `取消收藏 ${props.skill.name}` : `收藏 ${props.skill.name}`
          "
          :aria-pressed="favs.has(props.skill.id)"
          @click.prevent="favs.toggle(props.skill.id)"
        >
          <svg
            viewBox="0 0 24 24"
            class="size-4"
            :class="favs.has(props.skill.id) ? 'text-amber-500' : ''"
            :fill="favs.has(props.skill.id) ? 'currentColor' : 'none'"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"
            />
          </svg>
        </Button>
      </div>
      <h2 class="truncate text-base font-semibold tracking-tight" :title="props.skill.name">
        {{ props.skill.name }}
      </h2>
      <p class="text-muted-foreground mt-1 line-clamp-2 text-sm leading-relaxed">
        {{ props.skill.description }}
      </p>
    </RouterLink>
  </Card>
</template>
