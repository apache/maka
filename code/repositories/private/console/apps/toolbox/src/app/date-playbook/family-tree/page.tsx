import type { Metadata } from "next";
import { Badge } from "@ggbdpq/console-ui";
import { SpaceNav } from "../space-nav";
import { DEMO_ARCHIVE_SEED } from "@/features/date-playbook/mock/archive.demo.seed";
import type { FamilyChild, FamilyHousehold } from "@/features/date-playbook/domain/types";

// 家庭树页（源 family-tree + domain/archive/familyTree；演示种子，不含真实聊天数据）

export const metadata: Metadata = { title: "家庭树" };

function Household({ household }: { household: FamilyHousehold }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{household.title}</h3>
        {household.deceased ? <Badge variant="outline">已故</Badge> : null}
      </div>
      {household.relationNote ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{household.relationNote}</p>
      ) : null}
      <ul className="mt-3 space-y-2 text-sm">
        {household.children
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((child: FamilyChild) => (
            <li key={child.name}>
              <span className="font-medium">{child.name}</span>
              {child.spouse ? <span className="text-muted-foreground"> 配偶：{child.spouse}</span> : null}
              {child.grandchildren?.length ? (
                <span className="ml-2 inline-flex gap-1">
                  {child.grandchildren.map((g, i) => (
                    <Badge key={i} variant="secondary">
                      {g.label}
                    </Badge>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
      </ul>
    </div>
  );
}

export default function FamilyTreePage() {
  const tree = DEMO_ARCHIVE_SEED.familyTree;
  if (!tree.enabled) {
    return (
      <div>
        <SpaceNav active="/date-playbook/family-tree" />
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">家庭树未启用</p>
      </div>
    );
  }

  return (
    <div>
      <SpaceNav active="/date-playbook/family-tree" />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{tree.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tree.motto}
          {tree.year ? ` · ${tree.year}` : ""}
        </p>
      </header>
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">父系</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {tree.paternal.map((h) => (
            <Household key={h.id} household={h} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">母系</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {tree.maternal.map((h) => (
            <Household key={h.id} household={h} />
          ))}
        </div>
      </section>
    </div>
  );
}
