import { resolve } from "node:path";
import { defineConfig } from "vite";

const SERVER = process.env.AGENT_OFFICE_SERVER ?? "http://localhost:8787";

export default defineConfig({
  // Relative asset URLs keep the build portable (Worker static assets, previews).
  base: "./",
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
