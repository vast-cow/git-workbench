import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { GitService, browse, redact, repository } from "./git.ts";
import { openStore, operations } from "./db.ts";
import type { OperationInput } from "../../../packages/shared/src/index.ts";

const Str = Type.String({ minLength: 1, maxLength: 4096 });
const Input = Type.Object(
  {
    action: Type.Union(
      [
        "switch",
        "branch",
        "orphan",
        "reset",
        "merge",
        "fetch",
        "push",
        "stage",
        "unstage",
        "commit",
      ].map((v) => Type.Literal(v)),
    ),
    name: Type.Optional(Str),
    target: Type.Optional(Str),
    tracking: Type.Optional(Str),
    switchAfter: Type.Optional(Type.Boolean()),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })),
    allowEmpty: Type.Optional(Type.Boolean()),
    files: Type.Optional(Type.Array(Str, { maxItems: 1000 })),
    remotes: Type.Optional(Type.Array(Str, { maxItems: 100 })),
    mode: Type.Optional(
      Type.Union([
        Type.Literal("normal"),
        Type.Literal("lease"),
        Type.Literal("force"),
      ]),
    ),
    review: Type.Optional(Str),
    backup: Type.Optional(Str),
  },
  { additionalProperties: false },
);
const Id = Type.Object({ id: Type.Integer({ minimum: 1 }) });
export async function createApp(options: {
  database: string;
  port?: number;
  token?: string;
  webRoot?: string;
}) {
  const app = Fastify({ logger: false, bodyLimit: 100_000 });
  const store = openStore(options.database),
    service = new GitService();
  const token = options.token;
  const port = options.port ?? 4317;
  const jobs = new Map<
    string,
    { controller: AbortController; finished: boolean }
  >();
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.host !== `127.0.0.1:${port}`)
      return reply.code(403).send({ error: "Invalid Host" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return reply.code(403).send({ error: "Cross-site request blocked" });
    if (!req.url.startsWith("/api/")) return;
    if (token !== undefined) {
      const supplied = String(req.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      const a = Buffer.from(supplied),
        b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return reply
          .code(401)
          .send({ error: "Enter the access token printed by the local server" });
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    reply.header("X-Frame-Options", "DENY");
  });
  app.setErrorHandler((e, _req, reply) => {
    const error = e as Error & { validation?: unknown };
    return reply
      .code(error.validation ? 400 : 409)
      .send({ error: redact(error.message) });
  });
  app.get("/api/session", async () => ({ home: homedir() }));
  app.get("/api/repositories", async () => store.listRepos());
  app.post<{ Body: { path: string } }>(
    "/api/repositories",
    {
      schema: {
        body: Type.Object({ path: Str }, { additionalProperties: false }),
      },
    },
    async (req) =>
      auditImmediate(req.body.path, "register", req.body, async () =>
        store.register(await repository(req.body.path)),
      ),
  );
  app.get<{ Querystring: { path: string } }>(
    "/api/directories",
    { schema: { querystring: Type.Object({ path: Str }) } },
    (req) => browse(req.query.path),
  );
  app.delete<{ Params: { id: number } }>(
    "/api/repositories/:id",
    { schema: { params: Id } },
    async (req, reply) => {
      const path = store.repo(req.params.id);
      store.unregister(req.params.id);
      return reply.code(200).send({ path, unregistered: true });
    },
  );
  app.get<{ Params: { id: number } }>(
    "/api/repositories/:id",
    { schema: { params: Id } },
    (req) => service.inspect(store.repo(req.params.id)),
  );
  app.get<{ Params: { id: number }; Querystring: { commit: string } }>(
    "/api/repositories/:id/commit",
    { schema: { params: Id, querystring: Type.Object({ commit: Str }) } },
    async (req) => ({
      diff: await service.details(store.repo(req.params.id), req.query.commit),
    }),
  );
  app.get("/api/operations", async () => store.history());
  async function auditImmediate<T>(
    repo: string,
    type: string,
    params: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const id = randomUUID(),
      started = Date.now();
    store.db
      .insert(operations)
      .values({
        id,
        repo,
        type,
        params: redact(JSON.stringify(params)),
        started,
        status: "running",
      })
      .run();
    try {
      const result = await run();
      store.db
        .update(operations)
        .set({ status: "success", duration: Date.now() - started })
        .where(eq(operations.id, id))
        .run();
      return result;
    } catch (e) {
      store.db
        .update(operations)
        .set({
          status: "failed",
          error: redact(String(e)),
          duration: Date.now() - started,
        })
        .where(eq(operations.id, id))
        .run();
      throw e;
    }
  }
  async function launch(
    repo: string,
    type: string,
    params: unknown,
    run: (
      progress: (s: string) => void,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    const id = randomUUID(),
      started = Date.now(),
      controller = new AbortController();
    store.db
      .insert(operations)
      .values({
        id,
        repo,
        type,
        params: redact(JSON.stringify(params)),
        started,
        status: "running",
      })
      .run();
    const job = { controller, finished: false };
    jobs.set(id, job);
    let output = "";
    const progress = (s: string) => {
      output = (output + redact(s)).slice(-100_000);
      store.db
        .update(operations)
        .set({ output })
        .where(eq(operations.id, id))
        .run();
    };
    void service.serialize(repo, async () => {
      try {
        if (controller.signal.aborted) throw new Error("Operation cancelled");
        const before = await service.head(repo);
        store.db
          .update(operations)
          .set({ before })
          .where(eq(operations.id, id))
          .run();
        const result = await run(progress, controller.signal);
        progress("\n" + JSON.stringify(result ?? "") + "\n");
        const partial =
          Array.isArray(result) && result.some((r) => r.success === false);
        store.db
          .update(operations)
          .set({
            status: partial ? "partial-failure" : "success",
            error: partial
              ? "One or more remote pushes failed; inspect individual results"
              : null,
          })
          .where(eq(operations.id, id))
          .run();
      } catch (e) {
        store.db
          .update(operations)
          .set({ status: "failed", error: redact(String(e)) })
          .where(eq(operations.id, id))
          .run();
      } finally {
        store.db
          .update(operations)
          .set({
            after: await service.head(repo),
            duration: Date.now() - started,
          })
          .where(eq(operations.id, id))
          .run();
        job.finished = true;
        jobs.delete(id);
      }
    });
    return { id };
  }
  app.post<{ Body: { url: string; destination: string } }>(
    "/api/clone",
    {
      schema: {
        body: Type.Object(
          { url: Str, destination: Str },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      launch(
        req.body.destination,
        "clone",
        req.body,
        async (progress, signal) =>
          store.register(
            await service.cloneRepository(
              req.body.url,
              req.body.destination,
              progress,
              signal,
            ),
          ),
      ),
  );
  app.post<{ Params: { id: number }; Body: Static<typeof Input> }>(
    "/api/repositories/:id/review",
    { schema: { params: Id, body: Input } },
    (req) =>
      service.serialize(store.repo(req.params.id), () =>
        service.review(store.repo(req.params.id), req.body as OperationInput),
      ),
  );
  app.post<{ Params: { id: number }; Body: Static<typeof Input> }>(
    "/api/repositories/:id/operations",
    { schema: { params: Id, body: Input } },
    (req) => {
      const p = store.repo(req.params.id);
      return launch(p, req.body.action, req.body, (progress, signal) =>
        service.execute(p, req.body as OperationInput, progress, signal),
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/cancel",
    async (req) => {
      const j = jobs.get(req.params.id);
      if (!j) throw new Error("Operation is no longer running");
      j.controller.abort();
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/events",
    async (req, reply) => {
      if (
        !store.db
          .select()
          .from(operations)
          .where(eq(operations.id, req.params.id))
          .get()
      )
        return reply.code(404).send({ error: "Unknown operation" });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      const tick = () => {
        const row = store.db
          .select()
          .from(operations)
          .where(eq(operations.id, req.params.id))
          .get();
        reply.raw.write(`data: ${JSON.stringify(row)}\n\n`);
        if (row?.status !== "running") {
          clearInterval(timer);
          reply.raw.end();
        }
      };
      const timer = setInterval(tick, 300);
      tick();
      reply.raw.on("close", () => clearInterval(timer));
    },
  );
  const webRoot =
    options.webRoot ??
    fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(webRoot)) await app.register(staticPlugin, { root: webRoot });
  app.addHook("onClose", async () => {
    for (const job of jobs.values()) job.controller.abort();
    while (jobs.size) await new Promise((r) => setTimeout(r, 20));
    store.sqlite.close();
  });
  return { app, token, service, store };
}
