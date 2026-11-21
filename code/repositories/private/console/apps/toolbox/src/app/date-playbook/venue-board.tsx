"use client";
import { useEffect } from "react";
import { Heart } from "lucide-react";
import { Badge } from "@ggbdpq/console-ui";
import { CATEGORY_LABELS, venueCategorySchema, type Venue } from "@/schemas/venue";
import { useVenuesStore } from "@/stores/venues";

const SCENES = ["安静聊天", "拍照打卡", "雨天适合", "散步", "夜宵", "正餐"];

function VenueCard({ venue }: { venue: Venue }) {
  const toggleFavorite = useVenuesStore((s) => s.toggleFavorite);
  return (
    <article className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium hover:text-primary">
            <a href={`/date-playbook/venue/${venue.id}`}>{venue.name}</a>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {CATEGORY_LABELS[venue.category]} · {venue.area}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggleFavorite(venue.id)}
          aria-label={venue.favorite ? "取消收藏" : "收藏"}
          className="shrink-0 rounded-full p-1.5 transition-colors hover:bg-accent"
        >
          <Heart className={`size-4 ${venue.favorite ? "fill-destructive text-destructive" : "text-muted-foreground"}`} />
        </button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{venue.address}</p>
      {venue.signatureItems.length > 0 ? (
        <p className="mt-2 text-sm">招牌：{venue.signatureItems.join("、")}</p>
      ) : null}
      {venue.highlights.length > 0 ? (
        <p className="mt-1 text-sm text-foreground/80">亮点：{venue.highlights.join("、")}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {venue.suitableScenes.map((scene) => (
          <Badge key={scene} variant="secondary">
            {scene}
          </Badge>
        ))}
        {venue.isIndoor ? <Badge variant="outline">室内</Badge> : null}
        {venue.isFree ? <Badge variant="outline">免费</Badge> : null}
        {venue.bookingLevel === "required" ? <Badge variant="destructive">需预约</Badge> : null}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{venue.sourceNote}</p>
    </article>
  );
}

export function VenueBoard() {
  const { venues, total, loading, category, scene, onlyFavorite, setCategory, setScene, toggleOnlyFavorite, fetchVenues } =
    useVenuesStore();

  useEffect(() => {
    void fetchVenues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setCategory(undefined)}>
          <Badge variant={category ? "outline" : "default"}>全部</Badge>
        </button>
        {venueCategorySchema.options.map((c) => (
          <button key={c} type="button" onClick={() => setCategory(c)}>
            <Badge variant={category === c ? "default" : "outline"}>{CATEGORY_LABELS[c]}</Badge>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {SCENES.map((s) => (
          <button key={s} type="button" onClick={() => setScene(scene === s ? undefined : s)}>
            <Badge variant={scene === s ? "default" : "outline"}>{s}</Badge>
          </button>
        ))}
        <button type="button" onClick={toggleOnlyFavorite} className="ml-auto">
          <Badge variant={onlyFavorite ? "default" : "outline"}>
            <Heart className={`mr-1 inline size-3 ${onlyFavorite ? "fill-current" : ""}`} />
            只看收藏
          </Badge>
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        {loading ? "加载中…" : `共 ${total} 个地点`}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {venues.map((venue) => (
          <VenueCard key={venue.id} venue={venue} />
        ))}
      </div>
    </div>
  );
}
