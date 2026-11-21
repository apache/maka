<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import "highlight.js/styles/github-dark.css";

// 按需注册常用语言：全量引入会把主包撑过 500KB（prd item 8）
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("diff", diff);

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ZONE_LABEL } from "@/lib/schemas";
import { useFavoritesStore } from "@/stores/favorites";
import { useSkillsStore } from "@/stores/skills";
import { fetchSkillContent } from "@/api/skills";

const route = useRoute();
const store = useSkillsStore();
const favs = useFavoritesStore();

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch {
        /* 未知语言走兜底转义 */
      }
    }
    return "";
  },
});

const skill = computed(() => store.index?.skills.find((s) => s.id === route.params.id));
const content = ref("");
const loading = ref(false);
const error = ref("");

/** 正文 = SKILL.md 剥掉 frontmatter（元数据已在头部单独展示） */
const body = computed(() => content.value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""));
const rendered = computed(() => (body.value ? md.render(body.value) : ""));

async function loadContent() {
  if (!skill.value) return;
  loading.value = true;
  error.value = "";
  content.value = "";
  try {
    content.value = await fetchSkillContent(skill.value.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await store.load();
  await loadContent();
});
watch(
  () => route.params.id,
  () => {
    if (route.name === "skill") void loadContent();
  },
);

/** 候选池来源为 owner-slug 规范化名，仅两段时可无歧义还原 owner/repo */
const repo = computed(() => {
  const src = skill.value?.source;
  if (!src) return null;
  const parts = src.split("-");
  return parts.length === 2 ? { owner: parts[0], name: parts[1] } : null;
});

const facts = computed(() => {
  const s = skill.value;
  if (!s) return [];
  return [
    { term: "分类", value: s.category },
    { term: "子分类", value: s.subcategory },
    { term: "区域", value: ZONE_LABEL[s.zone] },
    { term: "来源仓库", value: s.source ?? "本库精选", mono: Boolean(s.source) },
    ...(s.author ? [{ term: "作者", value: s.author, mono: true }] : []),
  ];
});
</script>

<template>
  <div v-if="skill" class="mx-auto max-w-6xl">
    <!-- 面包屑 -->
    <div class="text-muted-foreground mb-4 flex flex-wrap items-center gap-1.5 text-sm">
      <RouterLink to="/" class="hover:text-foreground">浏览</RouterLink>
      <span>/</span>
      <span>{{ skill.category }}</span>
      <span>/</span>
      <span>{{ skill.subcategory }}</span>
    </div>

    <!-- 结构化头部 -->
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h1 class="font-mono text-2xl font-semibold">{{ skill.name }}</h1>
      <Badge
        :variant="
          skill.zone === 'pool' ? 'secondary' : skill.zone === 'archive' ? 'outline' : 'default'
        "
      >
        {{ ZONE_LABEL[skill.zone] }}
      </Badge>
      <Button variant="outline" size="sm" class="ml-auto" @click="favs.toggle(skill.id)">
        {{ favs.has(skill.id) ? "★ 已收藏" : "☆ 收藏" }}
      </Button>
    </div>
    <p class="text-muted-foreground mb-6 max-w-3xl text-sm leading-relaxed">
      {{ skill.description }}
    </p>

    <div class="flex flex-col gap-8 lg:flex-row">
      <!-- 主区 -->
      <div class="min-w-0 flex-1">
        <section class="bg-muted/40 mb-8 rounded-lg border p-4">
          <h2 class="mb-2 text-sm font-semibold">本体位置</h2>
          <code
            class="bg-background block overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs"
          >
            ~/.ai/categories/{{ skill.category }}/{{ skill.subcategory }}/{{ skill.name }}/
          </code>
          <template v-if="repo">
            <h2 class="mb-2 mt-4 text-sm font-semibold">安装命令</h2>
            <code
              class="bg-background block overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs"
            >
              npx skills add {{ repo.owner }}/{{ repo.name }}
            </code>
            <p class="text-muted-foreground mt-1.5 text-xs">
              仓库：<a
                class="text-primary underline underline-offset-4"
                :href="`https://github.com/${repo.owner}/${repo.name}`"
                target="_blank"
                rel="noreferrer"
                >github.com/{{ repo.owner }}/{{ repo.name }}</a
              >
            </p>
          </template>
        </section>

        <h2 class="mb-4 text-sm font-semibold tracking-wide uppercase">SKILL.md 原文</h2>
        <div v-if="loading" class="space-y-3">
          <Skeleton class="h-6 w-1/3" />
          <Skeleton class="h-4 w-full" />
          <Skeleton class="h-4 w-5/6" />
          <Skeleton class="h-4 w-4/6" />
        </div>
        <div
          v-else-if="error"
          class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm"
          role="alert"
        >
          正文加载失败：{{ error }}
        </div>
        <!-- markdown-it html:false 输出已转义原始 HTML，v-html 安全 -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-else class="markdown-body max-w-3xl" v-html="rendered" />
      </div>

      <!-- 事实卡侧栏 -->
      <aside class="hidden w-64 shrink-0 lg:block">
        <Card class="sticky top-20">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm">事实卡</CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <dl class="space-y-3">
              <div v-for="f in facts" :key="f.term">
                <dt class="text-muted-foreground text-xs">{{ f.term }}</dt>
                <dd class="mt-0.5 break-words" :class="{ 'font-mono text-xs': f.mono }">
                  {{ f.value }}
                </dd>
              </div>
            </dl>
            <Separator />
            <p class="text-muted-foreground text-xs">
              正文为 SKILL.md 原文渲染，改技能请直接编辑上述目录下的源文件，改完重跑
              <code class="font-mono">pnpm index</code>。
            </p>
          </CardContent>
        </Card>
      </aside>
    </div>
  </div>
  <div v-else-if="store.loading" class="text-muted-foreground text-sm">加载中…</div>
  <div v-else class="text-muted-foreground text-sm">
    未找到该技能，可能索引已过期，重跑 <code class="font-mono">pnpm index</code> 试试。
  </div>
</template>
