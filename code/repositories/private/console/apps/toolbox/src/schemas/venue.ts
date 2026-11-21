import { z } from "zod";

// 迁移自 date-playbook-miniapp domain/types + constants/venue（保留 Web 化所需字段子集）

export const venueCategorySchema = z.enum([
  "snack",
  "drink",
  "restaurant",
  "hotpot",
  "barbecue",
  "food_stall",
  "park",
  "museum",
  "cinema",
  "indoor_fun",
  "shopping",
]);
export type VenueCategory = z.infer<typeof venueCategorySchema>;

export const CATEGORY_LABELS: Record<VenueCategory, string> = {
  snack: "小吃",
  drink: "饮品",
  restaurant: "中餐",
  hotpot: "火锅",
  barbecue: "烧烤",
  food_stall: "大排档",
  park: "公园",
  museum: "博物馆",
  cinema: "电影院",
  indoor_fun: "室内玩乐",
  shopping: "商圈",
};

export const venueSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: venueCategorySchema,
  subCategory: z.string().optional(),
  address: z.string(),
  area: z.string(),
  /** 源 Venue 字段补齐（详情页展示用；种子暂无值的列不落库，保持 undefined） */
  openTime: z.string().optional(),
  avgPriceMin: z.number().optional(),
  avgPriceMax: z.number().optional(),
  ticketPriceText: z.string().optional(),
  bookingNote: z.string().optional(),
  longitude: z.number().optional(),
  latitude: z.number().optional(),
  signatureItems: z.array(z.string()),
  highlights: z.array(z.string()),
  suitableScenes: z.array(z.string()),
  reviewSummary: z.string().optional(),
  bookingLevel: z.enum(["none", "recommended", "required"]),
  isIndoor: z.boolean(),
  isFree: z.boolean(),
  timeTags: z.array(z.string()),
  weatherTags: z.array(z.string()),
  verifyStatus: z.enum(["unverified", "verified", "outdated"]),
  /** Web 版新增：本地收藏态（sqlite 持久化） */
  favorite: z.boolean(),
  sourceNote: z.string(),
});
export type Venue = z.infer<typeof venueSchema>;

export const venueFilterSchema = z.object({
  category: venueCategorySchema.optional(),
  scene: z.string().min(1).optional(),
  onlyFavorite: z.coerce.boolean().optional(),
});
export type VenueFilter = z.infer<typeof venueFilterSchema>;

export const venueListResponseSchema = z.object({
  items: z.array(venueSchema),
  total: z.number().int(),
});
export type VenueListResponse = z.infer<typeof venueListResponseSchema>;

export const favoriteResponseSchema = z.object({
  id: z.string(),
  favorite: z.boolean(),
});
export type FavoriteResponse = z.infer<typeof favoriteResponseSchema>;
