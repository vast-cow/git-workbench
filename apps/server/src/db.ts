import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, desc } from "drizzle-orm";
import { readFileSync } from "node:fs";
export const repositories = sqliteTable("repositories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
});
export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  repo: text("repo").notNull(),
  type: text("type").notNull(),
  params: text("params").notNull(),
  before: text("before_head"),
  after: text("after_head"),
  started: integer("started").notNull(),
  duration: integer("duration"),
  status: text("status").notNull(),
  output: text("output").notNull().default(""),
  error: text("error"),
});
export function openStore(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(
    readFileSync(new URL("../migrations/0001.sql", import.meta.url), "utf8"),
  );
  const db = drizzle(sqlite);
  db.update(operations)
    .set({
      status: "interrupted",
      error:
        "Server stopped before operation completed; inspect Git state before retrying",
    })
    .where(eq(operations.status, "running"))
    .run();
  return {
    sqlite,
    db,
    listRepos: () => db.select().from(repositories).all(),
    register: (path: string) => {
      db.insert(repositories).values({ path }).onConflictDoNothing().run();
      return db
        .select()
        .from(repositories)
        .where(eq(repositories.path, path))
        .get()!;
    },
    unregister: (id: number) =>
      db.delete(repositories).where(eq(repositories.id, id)).run().changes > 0,
    repo: (id: number) => {
      const r = db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id))
        .get();
      if (!r) throw new Error("Unknown repository");
      return r.path;
    },
    history: () =>
      db
        .select()
        .from(operations)
        .orderBy(desc(operations.started))
        .limit(200)
        .all(),
  };
}
