import { createRouter, createWebHashHistory } from "vue-router";

import BrowseView from "@/views/BrowseView.vue";
import CollectionsView from "@/views/CollectionsView.vue";
import SkillDetailView from "@/views/SkillDetailView.vue";
import StatsView from "@/views/StatsView.vue";

// hash 路由：纯静态托管（含 file:// 之外的任意子路径）零配置可用
const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "browse", component: BrowseView },
    { path: "/skill/:id", name: "skill", component: SkillDetailView },
    { path: "/stats", name: "stats", component: StatsView },
    { path: "/collections", name: "collections", component: CollectionsView },
  ],
});

export default router;
