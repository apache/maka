import { cache } from "react";
import { z } from "zod";
import {
  CapabilityDimensionSchema,
  DatabaseProductSchema,
  type DatabaseProduct,
} from "@/schemas/database";
import DATABASES from "@/data/database-products";import { CAPABILITY_DIMENSIONS } from "@/data/capability-dimensions";

// database 域唯一入口：8 款数据库 × 6 维度能力对比（数据迁移自 ggbdpq-site）

export const CATEGORY_LABELS: Record<string, string> = {
  relational: "关系型",
  nosql: "NoSQL",
  search: "搜索",
  "time-series": "时序",
  analytical: "分析型",
};

const loadProducts = cache(async (): Promise<DatabaseProduct[]> => {
  const parsed = z.array(DatabaseProductSchema).safeParse(DATABASES);
  if (!parsed.success) throw new Error("数据库产品数据损坏：" + parsed.error.issues[0]?.path.join("."));
  return parsed.data;
});

export const listProducts = cache(loadProducts);

export const getProduct = cache(async (id: string): Promise<DatabaseProduct | undefined> => {
  const all = await loadProducts();
  return all.find((p) => p.id === id);
});

export const getProductIds = cache(async () => (await loadProducts()).map((p) => p.id));

export const getDimensions = cache(async () => z.array(CapabilityDimensionSchema).parse(CAPABILITY_DIMENSIONS));

/** 总分 = 六维均分 */
export function totalScore(p: DatabaseProduct): number {
  const values = Object.values(p.scores);
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}
