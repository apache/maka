import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@ggbdpq/console-ui";
import { SpaceNav } from "../../space-nav";
import { FavoriteButtons } from "./favorite-buttons";
import { CATEGORY_LABELS } from "@/schemas/venue";
import { venueRepo } from "@/server/date-playbook/venues";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const venue = venueRepo.list({}).items.find((v) => v.id === id);
  return { title: venue ? `${venue.name} · 约会攻略` : "地点走丢了" };
}

const TIME_LABELS: Record<string, string> = {
  morning: "上午",
  noon: "中午",
  afternoon: "下午",
  evening: "晚上",
  late_night: "深夜",
};
const WEATHER_LABELS: Record<string, string> = { sunny: "晴天", rainy: "雨天", hot: "炎热", cool: "凉爽" };

export default async function VenueDetailPage({ params }: Props) {
  const { id } = await params;
  const venue = venueRepo.list({}).items.find((v) => v.id === id);
  if (!venue) notFound();

  return (
    <div>
      <SpaceNav active="/date-playbook" />
      <Link
        href="/date-playbook"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 地点库
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{venue.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {CATEGORY_LABELS[venue.category]} · {venue.area} · {venue.address}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {venue.isIndoor ? <Badge variant="outline">室内</Badge> : <Badge variant="outline">露天</Badge>}
          {venue.isFree ? <Badge variant="outline">免费</Badge> : null}
          {venue.bookingLevel === "required" ? <Badge variant="destructive">需预约</Badge> : null}
          {venue.bookingLevel === "recommended" ? <Badge variant="secondary">建议预约</Badge> : null}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">什么时候去</h2>
          <p className="text-sm text-muted-foreground">
            时段：{venue.timeTags.map((t) => TIME_LABELS[t] ?? t).join(" / ") || "待核验"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            天气：{venue.weatherTags.map((t) => WEATHER_LABELS[t] ?? t).join(" / ") || "不限"}
          </p>
          {venue.suitableScenes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {venue.suitableScenes.map((s) => (
                <Badge key={s} variant="secondary">
                  {s}
                </Badge>
              ))}
            </div>
          ) : null}
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">吃什么 / 玩什么</h2>
          {venue.signatureItems.length > 0 ? (
            <p className="text-sm">招牌：{venue.signatureItems.join("、")}</p>
          ) : (
            <p className="text-sm text-muted-foreground">暂无招牌信息（等待核验）</p>
          )}
          {venue.highlights.length > 0 ? (
            <p className="mt-1 text-sm text-foreground/80">亮点：{venue.highlights.join("、")}</p>
          ) : null}
          {venue.reviewSummary ? <p className="mt-2 text-sm text-muted-foreground">{venue.reviewSummary}</p> : null}
        </section>
      </div>

      <section className="mt-6 rounded-lg border border-dashed p-4">
        <h2 className="mb-2 font-medium">标记到我们的空间</h2>
        <FavoriteButtons venueId={venue.id} />
      </section>
      <p className="mt-4 text-xs text-muted-foreground">{venue.sourceNote}</p>
    </div>
  );
}
