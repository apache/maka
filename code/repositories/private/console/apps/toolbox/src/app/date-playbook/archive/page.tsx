import type { Metadata } from "next";
import { SpaceNav } from "../space-nav";
import { DEMO_ARCHIVE_SEED } from "@/features/date-playbook/mock/archive.demo.seed";
import { buildArchiveTopicTree } from "@/features/date-playbook/domain/archive/rules";
import type { TopicTreeNode } from "@/features/date-playbook/domain/archive/rules";

// 档案页（源 archive + visitFolders/timeline：拜访时间线 + 主题树；演示种子）

export const metadata: Metadata = { title: "档案" };

function Node({ node, depth = 0 }: { node: TopicTreeNode; depth?: number }) {
  const hasChildren = node.children?.length > 0;
  return (
    <details open={depth < 1} className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {node.title}
        <span className="ml-2 text-xs text-muted-foreground">{node.count} 条</span>
      </summary>
      {node.summaries?.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {node.summaries.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}
      {hasChildren ? (
        <div className="mt-2 space-y-2 pl-3">
          {node.children.map((child) => (
            <Node key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

export default function ArchivePage() {
  const visits = DEMO_ARCHIVE_SEED.visits ?? [];
  const topicTree = buildArchiveTopicTree(DEMO_ARCHIVE_SEED.items, DEMO_ARCHIVE_SEED.askedTopics);

  return (
    <div>
      <SpaceNav active="/date-playbook/archive" />
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">两人档案</h1>
        <p className="mt-1 text-sm text-muted-foreground">{DEMO_ARCHIVE_SEED.summary}</p>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">去过的地方（{visits.length}）</h2>
        {visits.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有拜访记录</p>
        ) : (
          <ol className="relative space-y-4 border-l pl-6">
            {visits.map((v, i) => (
              <li key={i} className="relative text-sm">
                <span className="absolute top-1.5 -left-[27px] size-2.5 rounded-full border-2 border-primary bg-background" />
                <span className="font-medium">{v.title}</span>
                <span className="ml-2 text-muted-foreground">{v.date}</span>
                {v.content ? <p className="mt-0.5 text-muted-foreground">{v.content}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">话题树</h2>
        <div className="space-y-2">
          {topicTree.map((node) => (
            <Node key={node.id} node={node} />
          ))}
        </div>
      </section>

      <p className="mt-8 text-xs text-muted-foreground">
        来源：{DEMO_ARCHIVE_SEED.source} · 真实档案需本机运行导入脚本生成，聊天原文不入库
      </p>
    </div>
  );
}
