import type { z } from "zod";
import type {
  dbMetaSchema,
  historyEventSchema,
  historyPayloadSchema,
  productSchema,
  productSearchParamsSchema,
  shopOptionSchema,
} from "./schemas";

export type Product = z.infer<typeof productSchema>;
export type ShopOption = z.infer<typeof shopOptionSchema>;
export type DbMeta = z.infer<typeof dbMetaSchema>;
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type HistoryPayload = z.infer<typeof historyPayloadSchema>;
export type ProductSearchParams = z.input<typeof productSearchParamsSchema>;
export type NormalizedProductSearchParams = z.output<
  typeof productSearchParamsSchema
>;
