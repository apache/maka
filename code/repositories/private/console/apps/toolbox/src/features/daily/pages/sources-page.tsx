import { demoSourceHealth, defaultSourceConfigs } from "@/data/daily-seed"

const statusLabel = {
  success: "正常",
  error: "失败",
  disabled: "关闭",
}

export function SourcesPage() {
  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold">信源健康</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        配置来自原 AI 日报的官方源列表。这里只展示离线健康快照，不会真正抓取。
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 font-medium">信源</th>
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">分类</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">条目</th>
            </tr>
          </thead>
          <tbody>
            {defaultSourceConfigs.map((source) => {
              const health = demoSourceHealth.find((row) => row.name === source.name)
              return (
                <tr key={source.name} className="border-t">
                  <td className="px-3 py-2">
                    <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {source.name}
                    </a>
                  </td>
                  <td className="px-3 py-2">{source.kind}</td>
                  <td className="px-3 py-2">{source.category}</td>
                  <td className="px-3 py-2">{health ? statusLabel[health.status as keyof typeof statusLabel] : "-"}</td>
                  <td className="px-3 py-2">
                    {health?.itemCount ?? 0}
                    {health?.message ? <span className="ml-2 text-xs text-muted-foreground">{health.message}</span> : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
