import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@ggbdpq/console-ui";
import { Markdown } from "@ggbdpq/console-ui";
import { DIFFICULTY_LABELS } from "@/schemas/problem";
import { JudgePanel } from "@/features/algo/judge";
import { getAllProblemSlugs, getProblemBySlug } from "@/server/problems";

export async function generateStaticParams() {
  return (await getAllProblemSlugs()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const problem = await getProblemBySlug(slug);
  if (!problem) return { title: "题目走丢了" };
  return { title: `${problem.id}. ${problem.title}`, description: problem.description.slice(0, 100) };
}

export default async function ProblemDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const problem = await getProblemBySlug(slug);
  if (!problem) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/algo"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 全部题目
      </Link>
      <header className="mt-6 mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          {problem.id}. {problem.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{DIFFICULTY_LABELS[problem.difficulty]}</Badge>
          {problem.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      </header>
      <section>
        <h2 className="mb-2 text-lg font-semibold">题目描述</h2>
        <Markdown content={problem.description} />
      </section>
      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">函数签名</h2>
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-[13px]">
          {`function ${problem.signature.entry}(${problem.signature.params
            .map((p) => `${p.name}: ${p.type}`)
            .join(", ")}): ${problem.signature.returns}`}
        </pre>
      </section>
      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">题解</h2>
        <Markdown content={problem.solution} />
      </section>
      <JudgePanel problem={problem} />
    </div>
  );
}
