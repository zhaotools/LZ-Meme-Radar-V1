import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/LZ-Meme-Radar-V1/",
  build: { sourcemap: true },
});
