import { Heart, MapPin, Pin, Eye } from "lucide-react";
import { Badge } from "@ggbdpq/console-ui";
import { formatDate } from "@/components/article-card";
import { momentSchema, type Moment } from "@/schemas/content";
import { moments as momentInputs } from "@/data/articles";

function MomentCard({ moment }: { moment: Moment }) {
  return (
    <article className="rounded-lg border p-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {moment.pinned ? <Pin className="size-3.5 text-primary" /> : null}
        <span>{formatDate(moment.date)}</span>
        {moment.location ? (
          <span className="inline-flex items-center gap-0.5">
            <MapPin className="size-3.5" />
            {moment.location}
          </span>
        ) : null}
      </div>
      <p className="mt-3 leading-7 whitespace-pre-wrap">{moment.content}</p>
      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Eye className="size-3.5" />
          {moment.views}
        </span>
        <span className="inline-flex items-center gap-1">
          <Heart className="size-3.5" />
          {moment.likes}
        </span>
      </div>
    </article>
  );
}

export default function HomePage() {
  // pinned 置顶优先，其余按日期降序；momentSchema 补 pinned 默认值
  const list = momentSchema
    .array()
    .parse(momentInputs)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date));

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">朋友圈</h1>
        <p className="mt-1 text-sm text-muted-foreground">记录即思考，分享即沉淀</p>
      </header>
      <div className="space-y-4">
        {list.map((moment) => (
          <MomentCard key={moment.id} moment={moment} />
        ))}
      </div>
      <div className="mt-6">
        <Badge variant="secondary">共 {list.length} 条动态</Badge>
      </div>
    </div>
  );
}
