import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@ggbdpq/console-ui";
import { CATEGORY_LABELS, listProducts, totalScore } from "@/server/database";

export const metadata: Metadata = { title: "数据库选型" };

export default async function DatabasePage() {
  const products = await listProducts();
  const ranked = [...products].sort((a, b) => totalScore(b) - totalScore(a));

  return (
    <div>
      <header className="mb-4">
        <h1 className="text-3xl font-semibold tracking-tight">数据库选型</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {products.length} 款数据库 × 6 维度能力评分 ·{" "}
          <Link href="/database/matrix" className="text-primary hover:underline">
            对比矩阵
          </Link>{" "}
          ·{" "}
          <Link href="/database/compare" className="text-primary hover:underline">
            两两对比
          </Link>{" "}
          ·{" "}
          <Link href="/database/analysis" className="text-primary hover:underline">
            分析
          </Link>
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {ranked.map((p, i) => (
          <Link
            key={p.id}
            href={`/database/${p.id}`}
            className="group rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-muted-foreground">#{i + 1}</span>
                <h3 className="font-medium group-hover:text-primary">{p.name}</h3>
              </div>
              <span className="text-lg font-bold text-primary">{totalScore(p)}</span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="secondary">{CATEGORY_LABELS[p.category]}</Badge>
              {p.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
