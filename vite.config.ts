import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 单一 Vite 配置同时构建 Worker（src/）与前端 React（web/）。
 *
 * - Vite root = web/，前端入口是 web/index.html
 * - Worker 入口由 wrangler.jsonc 的 main 指定（src/index.ts）
 * - dev 时 miniflare 在同一个端口跑 Worker，/api/* 与 /agents/* 无需反向代理
 *
 * vitest 跑纯逻辑单测（test/，外加 web/src 里那些不碰浏览器的纯函数），
 * 不需要 workerd 运行时；cloudflare 插件会把
 * 测试塞进 workers pool 并报 "exports is not defined"，所以测试时跳过它。
 */
const isTest = !!process.env.VITEST;

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  plugins: [
    ...(isTest
      ? []
      : [
          cloudflare({
            configPath: path.resolve(
              import.meta.dirname,
              process.env.HR_DESK_WRANGLER_CONFIG || "wrangler.jsonc",
            ),
          }),
        ]),
    react(),
  ],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  test: {
    root: path.resolve(import.meta.dirname),
    include: ["test/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
  },
});
