/**
 * 极简 frontmatter 解析：`---` 围栏内的 `key: value` 行。
 * 值支持 JSON 双引号字符串（迁移脚本写入形态）与裸字符串。
 * ponytail: 只支持本仓库迁移脚本的产出形态，需要 YAML 全集时再换 gray-matter。
 */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  // Windows 检出（autocrlf）会把 md 变成 CRLF，先归一化再解析，否则围栏匹配失败、字段全空
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: text };
  const head = text.slice(4, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);

  const data: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    try {
      data[key] = JSON.parse(value) as string;
    } catch {
      data[key] = value;
    }
  }
  return { data, body };
}
