import { z } from "zod";

export const ZONE_LABEL: Record<SkillZone, string> = {
  curated: "精选",
  pool: "候选池",
  archive: "归档",
};

export const skillZoneSchema = z.enum(["curated", "pool", "archive"]);
export type SkillZone = z.infer<typeof skillZoneSchema>;

export const skillMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  subcategory: z.string(),
  zone: skillZoneSchema,
  source: z.string().nullable(),
  author: z.string().nullable(),
});
export type SkillMeta = z.infer<typeof skillMetaSchema>;

export const subcategorySchema = z.object({
  path: z.string(),
  name: z.string(),
  zone: skillZoneSchema,
  category: z.string(),
  count: z.number(),
});
export type Subcategory = z.infer<typeof subcategorySchema>;

export const skillsIndexSchema = z.object({
  generatedAt: z.string(),
  total: z.number(),
  categories: z.array(subcategorySchema),
  skills: z.array(skillMetaSchema),
});
export type SkillsIndex = z.infer<typeof skillsIndexSchema>;
