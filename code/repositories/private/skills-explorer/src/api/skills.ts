import axios from "axios";

import { type SkillsIndex, skillsIndexSchema } from "@/lib/schemas";

// 静态数据随站点一起部署在 data/ 下；baseURL 拼 BASE_URL 以支持任意子路径托管
const http = axios.create({
  baseURL: new URL("data/", document.baseURI).toString(),
  timeout: 20000,
});

export async function fetchSkillsIndex(): Promise<SkillsIndex> {
  const res = await http.get("index.json");
  return skillsIndexSchema.parse(res.data);
}

export async function fetchSkillContent(id: string): Promise<string> {
  const res = await http.get(`content/${id}.md`, {
    responseType: "text",
    // 关闭 axios 的 JSON 解析猜测，保证 md 原文原样返回
    transformResponse: [(data) => data],
  });
  const data = res.data;
  if (typeof data !== "string" || data.length === 0) {
    throw new Error(
      `正文响应异常: type=${typeof data} status=${res.status} len=${(data as unknown)?.toString().length ?? 0}`,
    );
  }
  return data;
}
