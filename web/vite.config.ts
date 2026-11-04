// Builds the React page into web/dist, which `npm run serve` serves at "/".
// In dev (`npm run web:dev`) API calls are proxied to the agent API on :3000.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000", "/viewer": "http://localhost:3000" } },
});
