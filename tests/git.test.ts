import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitService,
  git,
  repository,
  browse,
  redact,
} from "../apps/server/src/git";
let dir: string, p: string, s: GitService, root: string;
async function commit(message: string) {
  await writeFile(join(p, "file"), message);
  await git(p, ["add", "file"]);
  await git(p, ["commit", "-m", message]);
  return s.head(p);
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitui-test-"));
  p = join(dir, "repo");
  await mkdir(p);
  await git(p, ["init", "-b", "main"]);
  await git(p, ["config", "user.name", "Test"]);
  await git(p, ["config", "user.email", "test@example.invalid"]);
  s = new GitService();
  root = await commit("root");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe("Git integration", () => {
  it("clones a local remote and refuses existing destinations", async () => {
    const dest = join(dir, "clone");
    await s.cloneRepository(p, dest);
    expect(await repository(dest)).toBe(dest);
    await expect(s.cloneRepository(p, dest)).rejects.toThrow();
    expect(await s.head(dest)).toBe(root);
  });
  it("discovers repositories and linked worktrees using Git", async () => {
    await git(p, ["worktree", "add", "-b", "linked", join(dir, "linked")]);
    expect(await repository(join(dir, "linked"))).toBe(join(dir, "linked"));
    const d = await browse(dir);
    expect(d.directories.filter((e) => e.isRepository)).toHaveLength(2);
    await mkdir(join(p, "sub"));
    await expect(repository(join(p, "sub"))).rejects.toThrow("root");
  });
  it("switches clean branches, refuses dirty/untracked/index changes and occupied branches", async () => {
    await s.execute(p, { action: "branch", name: "other", target: root });
    await s.execute(p, { action: "switch", name: "other" });
    expect(await s.branch(p)).toBe("other");
    await writeFile(join(p, "new"), "x");
    await expect(
      s.execute(p, { action: "switch", name: "main" }),
    ).rejects.toThrow("clean");
    await git(p, ["add", "new"]);
    await expect(
      s.execute(p, { action: "switch", name: "main" }),
    ).rejects.toThrow("clean");
    await git(p, ["reset", "--hard"]);
    await git(p, ["worktree", "add", join(dir, "occupied"), "main"]);
    await expect(
      s.execute(p, { action: "switch", name: "main" }),
    ).rejects.toThrow();
  });
  it("creates branches at commits without switching, validates names and objects", async () => {
    await commit("second");
    await s.execute(p, { action: "branch", name: "at-root", target: root });
    expect(await s.commitId(p, "at-root")).toBe(root);
    expect(await s.branch(p)).toBe("main");
    await expect(
      s.execute(p, { action: "branch", name: "at-root", target: root }),
    ).rejects.toThrow();
    await expect(
      s.execute(p, { action: "branch", name: "bad name", target: root }),
    ).rejects.toThrow();
    await expect(
      s.execute(p, { action: "branch", name: "tree", target: "HEAD^{tree}" }),
    ).rejects.toThrow();
  });
  it("creates a genuine empty root without touching index or files", async () => {
    await writeFile(join(p, "file"), "dirty");
    await writeFile(join(p, "staged"), "staged");
    await git(p, ["add", "staged"]);
    const before = await git(p, ["status", "--porcelain"]);
    await s.execute(p, { action: "orphan", name: "empty" });
    expect(
      (await git(p, ["show", "-s", "--format=%P%n%s", "empty"])).trim(),
    ).toBe("Initial commit");
    expect(await git(p, ["ls-tree", "-r", "empty"])).toBe("");
    expect(await git(p, ["status", "--porcelain"])).toBe(before);
    expect(await readFile(join(p, "file"), "utf8")).toBe("dirty");
    expect(await s.head(p)).toBe(root);
  });
  it("rejects reset to a non-ancestor and refuses dirty trees", async () => {
    await s.execute(p, { action: "orphan", name: "unrelated" });
    await expect(
      s.review(p, { action: "reset", target: "unrelated" }),
    ).rejects.toThrow();
    await writeFile(join(p, "loose"), "x");
    await expect(
      s.review(p, { action: "reset", target: root }),
    ).rejects.toThrow("clean");
  });
  it("resets with backup and rejects stale, reused or changed confirmation", async () => {
    const tip = await commit("second");
    const r = await s.review(p, { action: "reset", target: root });
    expect(r.lost).toContain("second");
    await s.execute(p, {
      action: "reset",
      target: root,
      review: r.token,
      backup: "backup",
    });
    expect(await s.head(p)).toBe(root);
    expect(await s.commitId(p, "backup")).toBe(tip);
    await expect(
      s.execute(p, { action: "reset", target: root, review: r.token }),
    ).rejects.toThrow("Review");
    const stale = await s.review(p, { action: "reset", target: root });
    await commit("external");
    await expect(
      s.execute(p, { action: "reset", target: root, review: stale.token }),
    ).rejects.toThrow("changed");
  });
  it("does not reset if backup exists or tree becomes dirty after review", async () => {
    const tip = await commit("second");
    let r = await s.review(p, { action: "reset", target: root });
    await expect(
      s.execute(p, {
        action: "reset",
        target: root,
        review: r.token,
        backup: "main",
      }),
    ).rejects.toThrow();
    expect(await s.head(p)).toBe(tip);
    r = await s.review(p, { action: "reset", target: root });
    await writeFile(join(p, "new"), "x");
    await expect(
      s.execute(p, { action: "reset", target: root, review: r.token }),
    ).rejects.toThrow("clean");
    expect(await s.head(p)).toBe(tip);
  });
  it("fast-forwards and refuses divergent merges without changing history", async () => {
    await git(p, ["switch", "-c", "feature"]);
    const tip = await commit("feature");
    await git(p, ["switch", "main"]);
    await s.execute(p, { action: "merge", name: "feature" });
    expect(await s.head(p)).toBe(tip);
    await commit("main advances");
    await git(p, ["switch", "feature"]);
    await commit("feature diverges");
    const before = await s.head(p);
    await expect(
      s.execute(p, { action: "merge", name: "main" }),
    ).rejects.toThrow();
    expect(await s.head(p)).toBe(before);
  });
  it("stages literal filenames, unstages, and creates manual and empty commits", async () => {
    await writeFile(join(p, ":(glob)*"), "x");
    await s.execute(p, { action: "stage", files: [":(glob)*"] });
    expect((await s.inspect(p)).files[0].index).toBe("A");
    await s.execute(p, { action: "unstage", files: [":(glob)*"] });
    expect((await s.inspect(p)).files[0].index).toBe("?");
    await s.execute(p, { action: "stage", files: [":(glob)*"] });
    await s.execute(p, { action: "commit", message: "manual" });
    await s.execute(p, {
      action: "commit",
      message: "empty",
      allowEmpty: true,
    });
    expect(
      (await git(p, ["show", "--format=%s", "--stat", "HEAD"])).trim(),
    ).toBe("empty");
    await expect(
      s.execute(p, { action: "commit", message: " " }),
    ).rejects.toThrow();
  });
  it("serializes mutations including worktrees and recovers after failure", async () => {
    const events: number[] = [];
    await git(p, ["worktree", "add", "-b", "linked", join(dir, "linked")]);
    await Promise.allSettled([
      s.serialize(p, async () => {
        events.push(1);
        await new Promise((r) => setTimeout(r, 60));
        events.push(2);
        throw new Error("test");
      }),
      s.serialize(join(dir, "linked"), async () => {
        events.push(3);
      }),
    ]);
    expect(events).toEqual([1, 2, 3]);
  });
  it("pushes normally, uses exact leases, forces explicitly and reports partial success", async () => {
    const remote = join(dir, "remote.git");
    await git(dir, ["init", "--bare", remote]);
    await git(p, ["remote", "add", "origin", remote]);
    async function push(mode: "normal" | "lease" | "force", review?: string) {
      const r =
        review ??
        (await s.review(p, { action: "push", mode, remotes: ["origin"] }))
          .token;
      return s.execute(p, {
        action: "push",
        mode,
        remotes: ["origin"],
        review: r,
      }) as Promise<any[]>;
    }
    expect((await push("normal"))[0].success).toBe(true);
    const tip = await commit("tip");
    await push("normal");
    await git(p, ["reset", "--hard", root]);
    expect((await push("normal"))[0].success).toBe(false);
    expect((await push("lease"))[0].success).toBe(true);
    await git(p, ["reset", "--hard", tip]);
    const reviewed = await s.review(p, {
      action: "push",
      mode: "lease",
      remotes: ["origin"],
    });
    await git(remote, ["update-ref", "refs/heads/main", tip]);
    expect((await push("lease", reviewed.token))[0].success).toBe(false);
    await git(p, ["reset", "--hard", root]);
    expect((await push("force"))[0].success).toBe(true);
    await git(p, ["remote", "add", "broken", join(dir, "missing")]);
    const r = await s.review(p, {
      action: "push",
      mode: "normal",
      remotes: ["origin"],
    });
    await expect(
      s.execute(p, {
        action: "push",
        mode: "force",
        remotes: ["origin"],
        review: r.token,
      }),
    ).rejects.toThrow("parameters");
    // Both remotes were available during review, one disappears before execution.
    const second = join(dir, "second.git");
    await git(dir, ["init", "--bare", second]);
    await git(p, ["remote", "set-url", "broken", second]);
    const multi = await s.review(p, {
      action: "push",
      mode: "normal",
      remotes: ["origin", "broken"],
    });
    await rm(second, { recursive: true });
    const result = (await s.execute(p, {
      action: "push",
      mode: "normal",
      remotes: ["origin", "broken"],
      review: multi.token,
    })) as any[];
    expect(result.map((v) => v.success)).toEqual([true, false]);
  });
  it("creates local tracking branches and reports history, diffs and ahead/behind", async () => {
    await git(p, ["remote", "add", "origin", p]);
    await s.execute(p, { action: "fetch", name: "origin" });
    await s.execute(p, {
      action: "switch",
      name: "tracked",
      tracking: "origin/main",
    });
    expect(await s.branch(p)).toBe("tracked");
    expect(
      (await s.inspect(p)).branches.find((b) => b.name === "tracked")?.upstream,
    ).toBe("origin/main");
    expect(await s.details(p, root)).toContain("root");
  });
  it("invalidates reset review when branch changes even at the same commit", async () => {
    const r = await s.review(p, { action: "reset", target: root });
    await git(p, ["switch", "-c", "other"]);
    await expect(
      s.execute(p, { action: "reset", target: root, review: r.token }),
    ).rejects.toThrow("changed");
  });
  it("rejects changing remote push URLs after review", async () => {
    const a = join(dir, "a.git"),
      b = join(dir, "b.git");
    await git(dir, ["init", "--bare", a]);
    await git(dir, ["init", "--bare", b]);
    await git(p, ["remote", "add", "origin", a]);
    const r = await s.review(p, {
      action: "push",
      mode: "normal",
      remotes: ["origin"],
    });
    await git(p, ["remote", "set-url", "--push", "origin", b]);
    const result = (await s.execute(p, {
      action: "push",
      mode: "normal",
      remotes: ["origin"],
      review: r.token,
    })) as any[];
    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("URL changed");
    expect(await git(b, ["show-ref", "--head"]).catch(() => "")).toBe("");
  });
  it("surfaces Git lock conflicts without changing HEAD", async () => {
    await writeFile(join(p, ".git", "index.lock"), "external lock");
    await expect(
      s.execute(p, { action: "commit", message: "blocked", allowEmpty: true }),
    ).rejects.toThrow("index.lock");
    expect(await s.head(p)).toBe(root);
  });
  it("handles subprocess timeouts and cancellation", async () => {
    await expect(
      git(p, ["-c", "alias.wait=!sleep 10", "wait"], { timeout: 30 }),
    ).rejects.toThrow("timed out");
    const controller = new AbortController();
    const running = git(p, ["-c", "alias.wait=!sleep 10", "wait"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(running).rejects.toThrow("cancelled");
  });
  it("stages and unstages files before the first commit", async () => {
    const unborn = join(dir, "unborn");
    await mkdir(unborn);
    await git(unborn, ["init", "-b", "main"]);
    await writeFile(join(unborn, "new"), "x");
    await s.execute(unborn, { action: "stage", files: ["new"] });
    await s.execute(unborn, { action: "unstage", files: ["new"] });
    expect((await s.inspect(unborn)).files[0].index).toBe("?");
  });
  it("redacts URL authentication and token query parameters", () => {
    expect(redact("https://user:secret@host/repo?token=abc")).toBe(
      "https://[redacted]@host/repo?token=[redacted]",
    );
  });
});
