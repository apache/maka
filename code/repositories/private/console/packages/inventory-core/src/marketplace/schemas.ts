import { z } from "zod";

export const inventoryItemSchema = z.object({
  id: z.string(),
  supplierId: z.string().optional(),
  supplier_id: z.string().optional(),
  supplierName: z.string().optional(),
  supplier_name: z.string().optional(),
  account: z.string(),
  plan: z.string(),
  status: z.string(),
  checkStatus: z.string().optional(),
  check_status: z.string().optional(),
  priceCents: z.number().optional(),
  price_cents: z.number().optional(),
});

export const orderSchema = z.object({
  id: z.string(),
  account: z.string(),
  supplierName: z.string().optional(),
  supplier_name: z.string().optional(),
  plan: z.string(),
  amountCents: z.number().optional(),
  amount_cents: z.number().optional(),
  status: z.string(),
  settlementStatus: z.string().optional(),
  settlement_status: z.string().optional(),
  pushStatus: z.string().optional(),
  push_status: z.string().optional(),
  createdAt: z.string().optional(),
  created_at: z.string().optional(),
});

export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type PurchaseOrder = z.infer<typeof orderSchema>;
