import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { releaseVersion } from "../../scripts/version.ts";

const SERVER = process.env.AGENT_OFFICE_SERVER ?? "http://localhost:8787";

function buildId(): string {
  const sha = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  // Relative asset URLs keep the build portable (Worker static assets, previews).
  base: "./",
  define: {
    __BUILD__: JSON.stringify(buildId()),
    __VERSION__: JSON.stringify(releaseVersion() ?? ""),
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: SERVER, ws: true, changeOrigin: true },
      "/api": { target: SERVER, changeOrigin: true },
      "/healthz": { target: SERVER, changeOrigin: true },
      "/install.sh": { target: SERVER, changeOrigin: true },
      "/login": { target: SERVER, changeOrigin: true },
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        stats: resolve(import.meta.dirname, "stats.html"),
        timelapse: resolve(import.meta.dirname, "timelapse.html"),
      },
    },
  },
});
