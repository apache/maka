"use client";
import { useState } from "react";
import { Badge } from "@ggbdpq/console-ui";
import type { DatabaseProduct } from "@/schemas/database";

// 两两对比：客户端双选，数据由 RSC 页面以 props 传入（不直连服务端模块）

function Column({ product, highlight }: { product: DatabaseProduct; highlight: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? "border-primary/50" : ""}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{product.name}</h3>
        {highlight ? <Badge>优</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {product.releaseYear} 年 · {product.license}
      </p>
    </div>
  );
}

export function CompareClient({ products, dimensions }: { products: DatabaseProduct[]; dimensions: { id: string; name: string }[] }) {
  const [aId, setAId] = useState(products[0]?.id ?? "");
  const [bId, setBId] = useState(products[1]?.id ?? "");
  const a = products.find((p) => p.id === aId);
  const b = products.find((p) => p.id === bId);
  if (!a || !b) return null;

  const select =
    (value: string, onChange: (v: string) => void) => (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border bg-background px-3 py-2 text-sm"
      >
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {select(aId, setAId)}
        <span className="text-sm text-muted-foreground">对比</span>
        {select(bId, setBId)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Column product={a} highlight={a.scores.performance + a.scores.reliability >= b.scores.performance + b.scores.reliability} />
        <Column product={b} highlight={b.scores.performance + b.scores.reliability > a.scores.performance + a.scores.reliability} />
      </div>
      <div className="mt-6 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-2.5 font-medium">维度</th>
              <th className="px-4 py-2.5 text-center font-medium">{a.shortName}</th>
              <th className="px-4 py-2.5 text-center font-medium">{b.shortName}</th>
              <th className="px-4 py-2.5 text-center font-medium">差值</th>
            </tr>
          </thead>
          <tbody>
            {dimensions.map((d) => {
              const sa = a.scores[d.id] ?? 0;
              const sb = b.scores[d.id] ?? 0;
              const diff = Math.round((sa - sb) * 10) / 10;
              return (
                <tr key={d.id} className="border-t">
                  <td className="px-4 py-2.5 font-medium">{d.name}</td>
                  <td className={`px-4 py-2.5 text-center ${diff > 0 ? "font-semibold text-primary" : "text-muted-foreground"}`}>{sa}</td>
                  <td className={`px-4 py-2.5 text-center ${diff < 0 ? "font-semibold text-primary" : "text-muted-foreground"}`}>{sb}</td>
                  <td className={`px-4 py-2.5 text-center ${diff !== 0 ? (diff > 0 ? "text-success" : "text-warning") : "text-muted-foreground"}`}>
                    {diff > 0 ? `+${diff}` : diff}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {[a, b].map((p) => (
          <div key={p.id} className="rounded-lg border p-4">
            <h4 className="font-medium">{p.shortName} 特性</h4>
            <ul className="mt-2 space-y-1 text-sm">
              {p.features.map((f) => (
                <li key={f.id} className={f.supported ? "" : "text-muted-foreground line-through"}>
                  {f.supported ? "✓" : "✗"} {f.name}
                  {f.description ? <span className="ml-1 text-xs text-muted-foreground">({f.description})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
