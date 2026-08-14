import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Le dashboard dev se connecte au backend local (port 8787) via un proxy : mêmes URLs
// qu'en production, où le build statique est servi par le backend lui-même.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
