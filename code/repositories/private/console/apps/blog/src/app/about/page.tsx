import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@ggbdpq/console-ui";
import { author, seriesList } from "@/data/articles";

export const metadata: Metadata = {
  title: "关于",
  description: `${author.name} · ${author.slogan}`,
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center gap-4">
        <span className="flex size-16 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
          {author.avatarText}
        </span>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{author.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {author.slogan} · {author.location}
          </p>
        </div>
      </div>
      <p className="mt-6 leading-7 text-foreground/90">{author.bio}</p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {author.badges.map((badge) => (
          <Badge key={badge} variant="secondary">
            {badge}
          </Badge>
        ))}
      </div>
      <dl className="mt-8 grid grid-cols-3 gap-3">
        {[
          { label: "文章", value: author.stats.articles },
          { label: "动态", value: author.stats.moments },
          { label: "系列", value: author.stats.series },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border p-4 text-center">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 text-2xl font-bold">{item.value}</dd>
          </div>
        ))}
      </dl>
      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">正在写的系列</h2>
        <ul className="space-y-2">
          {seriesList.map((series) => (
            <li key={series.name}>
              <Link
                href="/articles"
                className="block rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
              >
                <span className="font-medium">{series.name}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{series.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
