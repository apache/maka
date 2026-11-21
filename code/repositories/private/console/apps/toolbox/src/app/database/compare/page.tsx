import type { Metadata } from "next";
import { CompareClient } from "./compare-client";
import { getDimensions, listProducts } from "@/server/database";

export const metadata: Metadata = { title: "两两对比" };

export default async function ComparePage() {
  const [products, dimensions] = await Promise.all([listProducts(), getDimensions()]);

  return (
    <div>
      <header className="mb-4">
        <h1 className="text-3xl font-semibold tracking-tight">两两对比</h1>
        <p className="mt-1 text-sm text-muted-foreground">任选两款数据库，按 6 维度逐项对比</p>
      </header>
      <CompareClient products={products} dimensions={dimensions.map((d) => ({ id: d.id, name: d.name }))} />
    </div>
  );
}
