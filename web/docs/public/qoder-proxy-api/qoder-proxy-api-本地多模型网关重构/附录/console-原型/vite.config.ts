import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 真实产品由网关在 /ui 托管静态产物：base 设为 /ui/
export default defineConfig({
  base: process.env.CONSOLE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
});
