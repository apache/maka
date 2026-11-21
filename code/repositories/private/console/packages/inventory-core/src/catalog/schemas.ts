import { z } from "zod";

export const freshnessClassSchema = z.enum([
  "fresh-update-time",
  "warning-update-time",
  "stale-update-time",
]);

export const productSchema = z.object({
  duplicate_hidden: z.boolean(),
  duplicate_group: z.string(),
  status: z.string(),
  title: z.string(),
  item_url: z.string(),
  source: z.string(),
  shop_name: z.string(),
  shop_url: z.string(),
  category: z.string(),
  price_text: z.string(),
  stock_text: z.string(),
  updated_at: z.string(),
  freshness_class: freshnessClassSchema.or(z.string()),
  history_url: z.string(),
  image_url: z.string(),
  duplicate_toggle_text: z.string(),
});

export const shopOptionSchema = z.object({
  shop_id: z.string(),
  name: z.string(),
});

export const dbMetaSchema = z.object({
  updated_at: z.number(),
  updated_at_text: z.string(),
});

export const historyEventSchema = z.object({
  label: z.string(),
  value: z.string(),
  recorded_at: z.string().optional(),
});

export const historyPayloadSchema = z.object({
  times: z.array(z.string()),
  prices: z.array(z.number()),
  stocks: z.array(z.number()),
});

export const productSearchParamsSchema = z.object({
  keywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  shopId: z.string().optional(),
  status: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  searchDetails: z.boolean().optional(),
  sort: z.enum(["price", "updated_at", "stock", "title"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
});
