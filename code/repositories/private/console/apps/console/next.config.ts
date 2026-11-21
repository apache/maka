import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite 是 Node 内建模块，禁止被打包器改写
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
