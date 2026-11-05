import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * SITE_URL = public HTTPS address the app is served from (no trailing slash), e.g.
 *   https://arsten2026-cell.github.io/arsten-connect-docs
 * It is written into manifest.json, which Trimble Connect reads when the extension is installed.
 * In `npm run dev` the manifest points at https://localhost:5173.
 */
function manifest(): Plugin {
  const build = (site: string) =>
    JSON.stringify(
      {
        title: "Arsten Docs",
        description:
          "Document register, revisions, statuses, transmittals and todos for Arsten projects / Регистър на документи, ревизии, трансмитали и задачи",
        icon: `${site}/icon.png`,
        url: `${site}/index.html`,
        extensionType: ["project"],
        enabled: true,
      },
      null,
      2,
    );
  return {
    name: "arsten-manifest",
    configureServer(server) {
      server.middlewares.use("/manifest.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(build("https://localhost:5173"));
      });
    },
    generateBundle() {
      const site = (process.env.SITE_URL ?? "").replace(/\/$/, "");
      if (!site) this.warn("SITE_URL not set - manifest.json will contain relative URLs");
      this.emitFile({ type: "asset", fileName: "manifest.json", source: build(site) });
    },
  };
}

export default defineConfig({
  base: "./",
  // HTTPS is needed when Trimble Connect loads the dev server; NO_SSL=1 for a plain local preview.
  plugins: [...(process.env.NO_SSL ? [] : [basicSsl()]), manifest()],
  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    headers: { "Access-Control-Allow-Origin": "*" },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
