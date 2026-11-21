/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 接口基础路径，默认 /api（开发期由 mock 中间件承接，生产走网关） */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
