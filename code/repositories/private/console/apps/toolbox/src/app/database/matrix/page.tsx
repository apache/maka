import type { Metadata } from "next";
import Link from "next/link";
import { getDimensions, listProducts, totalScore } from "@/server/database";

export const metadata: Metadata = { title: "数据库对比矩阵" };

function scoreCell(score: number): string {
  if (score >= 9) return "bg-success/15 text-success";
  if (score >= 7.5) return "bg-success/10 text-foreground";
  if (score >= 6) return "bg-warning/10 text-foreground";
  return "bg-destructive/10 text-muted-foreground";
}

export default async function MatrixPage() {
  const [products, dimensions] = await Promise.all([listProducts(), getDimensions()]);

  return (
    <div>
      <header className="mb-4">
        <h1 className="text-3xl font-semibold tracking-tight">对比矩阵</h1>
        <p className="mt-1 text-sm text-muted-foreground">6 维度 × 18 子项评分总览</p>
      </header>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="sticky left-0 bg-muted/50 px-4 py-2.5 text-left font-medium">数据库</th>
              <th className="px-3 py-2.5 text-center font-medium">总分</th>
              {dimensions.map((d) => (
                <th key={d.id} className="px-3 py-2.5 text-center font-medium" title={d.description}>
                  {d.shortName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...products].sort((a, b) => totalScore(b) - totalScore(a)).map((p) => (
              <tr key={p.id} className="border-t">
                <td className="sticky left-0 bg-background px-4 py-2.5">
                  <Link href={`/database/${p.id}`} className="font-medium hover:text-primary">
                    {p.shortName}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-center font-semibold text-primary">{totalScore(p)}</td>
                {dimensions.map((d) => {
                  const score = p.scores[d.id] ?? 0;
                  return (
                    <td key={d.id} className="px-2 py-2.5 text-center">
                      <span className={`inline-block w-12 rounded-md py-0.5 ${scoreCell(score)}`}>{score}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
