import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Star } from "lucide-react";
import { Badge } from "@ggbdpq/console-ui";
import { CATEGORY_LABELS, getDimensions, getProduct, getProductIds, totalScore } from "@/server/database";

export async function generateStaticParams() {
  return (await getProductIds()).map((databaseId) => ({ databaseId }));
}

export async function generateMetadata({ params }: { params: Promise<{ databaseId: string }> }): Promise<Metadata> {
  const { databaseId } = await params;
  const product = await getProduct(databaseId);
  return { title: product ? `${product.name} 详情` : "数据库走丢了" };
}

export default async function DatabaseDetailPage({ params }: { params: Promise<{ databaseId: string }> }) {
  const { databaseId } = await params;
  const [product, dimensions] = await Promise.all([getProduct(databaseId), getDimensions()]);
  if (!product) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/database"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 数据库选型
      </Link>
      <header className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{CATEGORY_LABELS[product.category]}</Badge>
          <Badge variant="outline">{product.license}</Badge>
          {product.githubStars ? (
            <Badge variant="outline">
              <Star className="mr-1 inline size-3" />
              {(product.githubStars / 1000).toFixed(0)}k
            </Badge>
          ) : null}
        </div>
        <h1 className="mt-3 text-3xl font-bold">{product.name}</h1>
        <p className="mt-3 leading-7 text-foreground/90">{product.description}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {product.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      </header>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold">能力评分（总分 {totalScore(product)}）</h2>
        <div className="space-y-3">
          {dimensions.map((d) => {
            const score = product.scores[d.id] ?? 0;
            return (
              <div key={d.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span title={d.description}>{d.name}</span>
                  <span className="font-medium text-primary">{score}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${score * 10}%` }} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                  {d.subMetrics.map((m) => (
                    <span key={m.id}>
                      {m.name} {product.subScores[d.id]?.[m.id] ?? "-"}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">特性支持</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {product.features.map((f) => (
            <div key={f.id} className={`rounded-lg border p-3 text-sm ${f.supported ? "" : "text-muted-foreground"}`}>
              {f.supported ? "✓" : "✗"} {f.name}
              {f.description ? <div className="mt-0.5 text-xs text-muted-foreground">{f.description}</div> : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
