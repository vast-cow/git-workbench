import { it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/src/app";
import { git } from "../apps/server/src/git";
it("authenticates API, validates origins and schemas, persists successful and failed operations with SSE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitui-api-"));
  const p = join(dir, "repo");
  await mkdir(p);
  await git(p, ["init", "-b", "main"]);
  await git(p, ["config", "user.name", "Test"]);
  await git(p, ["config", "user.email", "test@example.invalid"]);
  await git(p, ["commit", "--allow-empty", "-m", "root"]);
  const { app, store } = await createApp({
    database: join(dir, "db.sqlite"),
    token: "secret",
  });
  const headers = { host: "127.0.0.1:4317", authorization: "Bearer secret" };
  try {
    expect(
      (
        await app.inject({
          url: "/api/repositories",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/repositories",
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/directories?path=/",
          headers: { ...headers, host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    const registered = (
      await app.inject({
        method: "POST",
        url: "/api/repositories",
        headers,
        payload: { path: p },
      })
    ).json();
    expect(registered.path).toBe(p);
    const url = `/api/repositories/${registered.id}/operations`;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { action: "shell", command: "id" },
        })
      ).statusCode,
    ).toBe(400);
    const success = (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { action: "commit", message: "empty", allowEmpty: true },
      })
    ).json();
    const stream = await app.inject({
      url: `/api/operations/${success.id}/events`,
      headers,
    });
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("success");
    const fail = (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { action: "switch", name: "missing" },
      })
    ).json();
    await app.inject({ url: `/api/operations/${fail.id}/events`, headers });
    const history = (
      await app.inject({ url: "/api/operations", headers })
    ).json();
    expect(history).toHaveLength(3);
    const mutations = history.filter((r: any) => r.type !== "register");
    expect(mutations.map((r: any) => r.status).sort()).toEqual([
      "failed",
      "success",
    ]);
    expect(
      mutations.every((r: any) => r.before && r.after && r.duration !== null),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
