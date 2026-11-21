import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@ggbdpq/console-ui";
import { DIFFICULTY_LABELS, difficultySchema, type Difficulty } from "@/schemas/problem";
import { listProblems } from "@/server/problems";

export const metadata: Metadata = {
  title: "算法",
  description: "LeetCode 风格题库，含题解",
};

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: "bg-success/15 text-success",
  medium: "bg-warning/15 text-warning",
  hard: "bg-destructive/15 text-destructive",
};

export default async function AlgoPage({
  searchParams,
}: {
  searchParams: Promise<{ difficulty?: string }>;
}) {
  const { difficulty } = await searchParams;
  const parsed = difficultySchema.safeParse(difficulty);
  const active = parsed.success ? parsed.data : undefined;
  const problems = await listProblems(active ? { difficulty: active } : {});

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">算法</h1>
        <p className="mt-1 text-sm text-muted-foreground">共 {problems.length} 题</p>
      </header>
      <div className="mb-4 flex gap-2">
        <Link href="/algo">
          <Badge variant={active ? "outline" : "default"}>全部</Badge>
        </Link>
        {difficultySchema.options.map((d) => (
          <Link key={d} href={`/algo?difficulty=${d}`}>
            <Badge variant={active === d ? "default" : "outline"}>{DIFFICULTY_LABELS[d]}</Badge>
          </Link>
        ))}
      </div>
      <ol className="divide-y rounded-lg border">
        {problems.map((p) => (
          <li key={p.id}>
            <Link
              href={`/algo/${p.slug}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
            >
              <span className="w-10 shrink-0 text-sm text-muted-foreground">{p.id}</span>
              <span className="flex-1 font-medium">{p.title}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${DIFFICULTY_STYLE[p.difficulty]}`}>
                {DIFFICULTY_LABELS[p.difficulty]}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
