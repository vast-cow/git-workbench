import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createApp } from "./app.ts";
const data =
  process.env.GITUI_DATA_DIR ??
  join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "git-webui",
  );
mkdirSync(data, { recursive: true, mode: 0o700 });
const port = Number(process.env.PORT ?? 4317);
const { app } = await createApp({
  database: join(data, "gitui.sqlite"),
  port,
});
await app.listen({ host: "127.0.0.1", port });
console.log(
  `Git Web UI: http://127.0.0.1:${port}\nDevelopment UI: http://127.0.0.1:5173`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
