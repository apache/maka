export interface EndpointDef {
  method: string;
  path: string;
  description: string;
  mutates?: boolean;
  query?: string[];
  defaultQuery?: Record<string, string>;
  multipart?: boolean;
}

export const ENDPOINTS: Readonly<Record<string, EndpointDef>> = Object.freeze({
  "create-project": {
    method: "POST",
    path: "/api/projects",
    description: "建项目",
    mutates: true,
  },
  "project-access": {
    method: "GET",
    path: "/api/project-access",
    description: "项目访问权；query: d=UUID",
    query: ["d"],
  },
  "conversation-history": {
    method: "POST",
    path: "/api/codex/conversation-history",
    description: "Codex 会话历史",
  },
  "llm-start": {
    method: "POST",
    path: "/api/llm/response_with_tools_start",
    description: "AI 调用入口",
  },
  "llm-status": {
    method: "POST",
    path: "/api/llm/response_with_tools_status",
    description: "AI 调用轮询状态",
  },
  "render": {
    method: "POST",
    path: "/s/sandboxes/proxy/render",
    description: "LaTeX 编译 / 渲染启动",
  },
  "render-status": {
    method: "GET",
    path: "/s/sandboxes/proxy/render-status",
    description: "LaTeX 编译 / 渲染状态；query: waitMs=10000",
    defaultQuery: { waitMs: "10000" },
  },
  "upload": {
    method: "POST",
    path: "/api/project-files/upload",
    description: "项目文件上传；multipart file=<path>",
    mutates: true,
    multipart: true,
  },
  "thumbnail": {
    method: "PATCH",
    path: "/api/projects/{uuid}/thumbnail",
    description: "更新项目缩略图；path: uuid",
    mutates: true,
  },
});

export function endpointNames(): string[] {
  return Object.keys(ENDPOINTS);
}

export function getEndpoint(name: string): EndpointDef {
  const endpoint = ENDPOINTS[name];
  if (!endpoint) {
    throw new Error(`Unknown endpoint '${name}'. Run: prismctl list-endpoints`);
  }
  return endpoint;
}
