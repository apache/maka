import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite 是 Node 内建模块，禁止被打包器改写；transformers.js/onnxruntime-web 含 wasm 与
  // 动态资源，交由 Node 原生加载，不进打包器
  serverExternalPackages: ["node:sqlite", "@huggingface/transformers", "onnxruntime-web"],
};

export default nextConfig;
