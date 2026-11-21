import { z } from 'zod';

export const DatabaseCategoryEnum = z.enum([
  'relational',
  'nosql',
  'search',
  'time-series',
  'analytical',
]);

export type DatabaseCategory = z.infer<typeof DatabaseCategoryEnum>;

export const CapabilityDimensionSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  description: z.string(),
  category: z.enum(['performance', 'reliability', 'scalability', 'security', 'ecosystem', 'advanced']),
  subMetrics: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
  })),
});

export type CapabilityDimension = z.infer<typeof CapabilityDimensionSchema>;

export const DatabaseProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  version: z.string(),
  category: DatabaseCategoryEnum,
  description: z.string(),
  logoUrl: z.string().optional(),
  releaseYear: z.number(),
  license: z.string(),
  website: z.string().optional(),
  githubStars: z.number().optional(),
  scores: z.record(z.string(), z.number().min(0).max(10)),
  subScores: z.record(z.string(), z.record(z.string(), z.number().min(0).max(10))),
  features: z.array(z.object({
    id: z.string(),
    name: z.string(),
    supported: z.boolean(),
    description: z.string().optional(),
  })),
  tags: z.array(z.string()),
});

export type DatabaseProduct = z.infer<typeof DatabaseProductSchema>;

export const DatabaseFilterSchema = z.object({
  search: z.string().optional(),
  categories: z.array(DatabaseCategoryEnum).optional(),
  minScore: z.number().min(0).max(10).optional(),
  maxScore: z.number().min(0).max(10).optional(),
  dimensions: z.array(z.string()).optional(),
  sortBy: z.string().optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
});

export type DatabaseFilter = z.infer<typeof DatabaseFilterSchema>;

export const WeightConfigSchema = z.record(z.string(), z.number().min(0).max(5));
export type WeightConfig = z.infer<typeof WeightConfigSchema>;

export const ComparisonItemSchema = z.object({
  databaseId: z.string(),
  notes: z.string().optional(),
});
export type ComparisonItem = z.infer<typeof ComparisonItemSchema>;
