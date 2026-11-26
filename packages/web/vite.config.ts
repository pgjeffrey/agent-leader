import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonPort = Number(process.env.AGENT_LEADER_PORT || 6868);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: false,
      },
      "/ws": {
        target: `ws://127.0.0.1:${daemonPort}`,
        ws: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: false,
  },
});
