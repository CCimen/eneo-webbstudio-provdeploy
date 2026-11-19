import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { handleChat } from "./server/chat-proxy.mjs";

// Gör att /api/chat fungerar i `npm run dev` med nycklarna i .env.local.
// I produktion sköts samma sak av server/serve.mjs.
function eneoChatDev(): Plugin {
  return {
    name: "eneo-chat-dev",
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), "ENEO_");
      server.middlewares.use("/api/chat", (req, res) => void handleChat(req, res, env));
    },
  };
}

export default defineConfig({
  plugins: [react(), eneoChatDev()],
});
