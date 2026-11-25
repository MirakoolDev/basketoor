import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // deployments/*.json live in ../contracts
  server: { fs: { allow: [".."] }, port: 5173 },
});
