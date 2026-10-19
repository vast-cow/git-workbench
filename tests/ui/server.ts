import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app";
import { git } from "../../apps/server/src/git";
const dir = await mkdtemp(join(tmpdir(), "gitui-browser-"));
const repo = join(dir, "smoke-repository");
await mkdir(repo);
await git(repo, ["init", "-b", "main"]);
await git(repo, ["config", "user.name", "Smoke"]);
await git(repo, ["config", "user.email", "smoke@example.invalid"]);
await git(repo, ["commit", "--allow-empty", "-m", "first"]);
const { app, store } = await createApp({
  database: join(dir, "data.sqlite"),
  port: 4318,
  token: "smoke-token",
});
store.register(repo);
await app.listen({ host: "127.0.0.1", port: 4318 });
process.on(
  "SIGTERM",
  () =>
    void app
      .close()
      .then(() => rm(dir, { recursive: true, force: true }))
      .then(() => process.exit()),
);
