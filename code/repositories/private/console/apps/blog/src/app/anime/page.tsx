import type { Metadata } from "next";
import { AnimeTierList } from "@/features/anime/tier-list";

export const metadata: Metadata = {
  title: "动漫分层",
  description: "动漫评分 Tier List：拖拽分层、撤销重做、本地保存",
};

export default function AnimePage() {
  return <AnimeTierList />;
}
