import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApp } from "./app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 5173);

const app = createApp();
const vite = await createViteServer({
  root,
  configFile: path.join(root, "vite.client.config.ts"),
  server: { middlewareMode: true },
  appType: "spa",
});
app.use(vite.middlewares);

app.listen(port, "0.0.0.0", () => {
  console.log(`Terading paper terminal on http://0.0.0.0:${port}`);
});
