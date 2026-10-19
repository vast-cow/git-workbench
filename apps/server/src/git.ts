import { spawn } from "node:child_process";
import { realpath, readdir, mkdir } from "node:fs/promises";
import { isAbsolute, resolve, dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OperationInput,
  Review,
} from "../../../packages/shared/src/index.ts";

export function redact(s: string): string {
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:token|access_token|password|key|secret)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/(authorization:\s*)[^\r\n]+/gi, "$1[redacted]");
}
export type Progress = (text: string) => void;
export async function git(
  cwd: string,
  args: string[],
  options: {
    input?: string;
    progress?: Progress;
    signal?: AbortSignal;
    timeout?: number;
  } = {},
): Promise<string> {
  const environment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  // Never let an inherited Git context redirect commands outside the selected repository.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    delete (environment as NodeJS.ProcessEnv)[key];
  return new Promise((ok, fail) => {
    const child = spawn(
      "git",
      ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", ...args],
      {
        cwd,
        shell: false,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    let stdout = "",
      stderr = "",
      ended = false,
      timedOut = false,
      cancelled = false;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* already exited */
        }
      }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 3000);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeout ?? 120_000);
    function done(error?: Error) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      error ? fail(error) : ok(stdout);
    }
    child.on("error", done);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > 8_000_000) {
        kill("SIGKILL");
        done(new Error("Git output exceeds 8 MB; narrow the request"));
      }
    });
    // Buffer until line boundaries so credentials split across chunks are not leaked.
    let pending = "";
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString();
      stderr = (stderr + s).slice(-1_000_000);
      pending += s;
      const parts = pending.split(/[\r\n]/);
      pending = parts.pop()!.slice(-1_000_000);
      for (const line of parts) options.progress?.(redact(line) + "\n");
    });
    child.on("close", (code, signal) => {
      if (pending) options.progress?.(redact(pending));
      done(
        code === 0 && !timedOut && !cancelled
          ? undefined
          : new Error(
              redact(
                cancelled
                  ? "Git operation cancelled"
                  : timedOut
                    ? "Git operation timed out"
                    : stderr.trim() || `Git exited ${code ?? signal}`,
              ),
            ),
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
const safe = (value: string | undefined, label: string): string => {
  if (!value || value.startsWith("-") || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
};
export async function repository(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Use an absolute repository path");
  const p = await realpath(path);
  if ((await git(p, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true")
    throw new Error("Not a working repository");
  const root = await realpath(
    (await git(p, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (root !== p) throw new Error(`Select the repository root: ${root}`);
  return root;
}
export async function browse(path: string) {
  if (!isAbsolute(path)) throw new Error("Use an absolute directory path");
  const root = await realpath(path);
  const entries = await readdir(root, { withFileTypes: true });
  const directories = [];
  for (const e of entries
    .filter((e) => e.isDirectory() && e.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(root, e.name);
    let isRepository = false;
    try {
      await repository(p);
      isRepository = true;
    } catch {
      /* ordinary directory */
    }
    directories.push({ name: e.name, path: p, isRepository });
  }
  let isRepository = false;
  try {
    await repository(root);
    isRepository = true;
  } catch {
    /* ordinary directory */
  }
  return { path: root, parent: dirname(root), isRepository, directories };
}
export class GitService {
  private queues = new Map<string, Promise<unknown>>();
  private reviews = new Map<
    string,
    Review & {
      repo: string;
      expires: number;
      kind: string;
      urls: Record<string, string>;
    }
  >();
  async serialize<T>(path: string, run: () => Promise<T>): Promise<T> {
    // Linked worktrees share refs: lock the common Git directory, not just the worktree.
    let key = path;
    try {
      key = await realpath(
        resolve(
          path,
          (await git(path, ["rev-parse", "--git-common-dir"])).trim(),
        ),
      );
    } catch {
      /* clone destination */
    }
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  async head(p: string) {
    try {
      return (await git(p, ["rev-parse", "--verify", "HEAD"])).trim();
    } catch {
      return "";
    }
  }
  async branch(p: string) {
    try {
      return (
        await git(p, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      ).trim();
    } catch {
      throw new Error("Operation requires an attached branch");
    }
  }
  async clean(p: string) {
    if (
      await git(p, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    )
      throw new Error("Working tree must be clean, including untracked files");
  }
  async commitId(p: string, ref: string | undefined) {
    return (
      await git(p, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${safe(ref, "commit")}^{commit}`,
      ])
    ).trim();
  }
  async newBranch(p: string, name: string | undefined) {
    const n = safe(name, "branch name");
    await git(p, ["check-ref-format", "--branch", n]);
    if (n === "HEAD" || n.startsWith("@{-"))
      throw new Error("Use a literal branch name");
    const refs = await git(p, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${n}`,
    ]);
    if (refs.split("\n").includes(`refs/heads/${n}`))
      throw new Error("Branch already exists");
    return n;
  }
  async remote(p: string, name: string) {
    safe(name, "remote");
    if (!(await git(p, ["remote"])).trim().split("\n").includes(name))
      throw new Error("Unknown remote");
    return name;
  }
  async localBranch(p: string, name: string | undefined) {
    const n = safe(name, "branch");
    await git(p, ["show-ref", "--verify", `refs/heads/${n}`]);
    return n;
  }
  async inspect(p: string) {
    const status = await git(p, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const chunks = status.split("\0"),
      files: {
        path: string;
        index: string;
        worktree: string;
        original?: string;
      }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!c) continue;
      const f = {
        path: c.slice(3),
        index: c[0],
        worktree: c[1],
        original: undefined as string | undefined,
      };
      if (/[RC]/.test(c.slice(0, 2))) f.original = chunks[++i];
      files.push(f);
    }
    const head = await this.head(p);
    let branch = "(detached)";
    try {
      branch = await this.branch(p);
    } catch {}
    const branches = (
      await git(p, [
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(upstream:short)%09%(upstream:track)%09%(worktreepath)",
        "refs/heads",
        "refs/remotes",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, oid, upstream, tracking, worktree] = line.split("\t");
        return {
          ref,
          name: ref.replace(/^refs\/(heads|remotes)\//, ""),
          remote: ref.startsWith("refs/remotes/"),
          oid,
          upstream,
          tracking,
          worktree,
        };
      });
    const history = head ? await this.history(p) : [];
    return {
      path: p,
      head,
      branch,
      files,
      branches,
      history,
      remotes: redact(await git(p, ["remote", "-v"])),
      worktrees: await git(p, ["worktree", "list", "--porcelain"]),
      status: await git(p, ["status", "--short", "--branch"]),
      staged: await git(p, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
      ]),
      unstaged: await git(p, ["diff", "--no-ext-diff", "--no-textconv"]),
    };
  }
  async history(p: string) {
    const out = await git(p, [
      "log",
      "-100",
      "--format=%H%x00%an%x00%aI%x00%s%x00",
    ]);
    const parts = out.split("\0");
    const rows = [];
    for (let i = 0; i + 3 < parts.length; i += 4)
      rows.push({
        oid: parts[i].trim(),
        author: parts[i + 1],
        date: parts[i + 2],
        message: parts[i + 3],
      });
    return rows;
  }
  async details(p: string, ref: string) {
    const oid = await this.commitId(p, ref);
    return git(p, [
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--format=fuller",
      oid,
      "--",
    ]);
  }
  async cloneRepository(
    url: string,
    destination: string,
    progress?: Progress,
    signal?: AbortSignal,
  ) {
    safe(url, "Git URL");
    if (/^(?:ext|file)::/i.test(url)) throw new Error("Unsupported transport");
    if (!isAbsolute(destination))
      throw new Error("Use an absolute destination");
    const parent = await realpath(dirname(destination)),
      dest = join(parent, basename(destination));
    // mkdir is atomic, so even an empty pre-existing destination is never reused.
    await mkdir(dest);
    await git(parent, ["clone", "--progress", "--", url, dest], {
      progress,
      signal,
      timeout: 600_000,
    });
    return repository(dest);
  }
  async pushUrl(p: string, remote: string) {
    const urls = (
      await git(p, ["remote", "get-url", "--push", "--all", remote])
    )
      .trim()
      .split("\n");
    if (urls.length !== 1)
      throw new Error("Configure exactly one push URL per remote");
    return safe(urls[0], "push URL");
  }
  async review(p: string, input: OperationInput): Promise<Review> {
    const urls: Record<string, string> = {};
    const head = await this.head(p),
      branch = await this.branch(p);
    if (!head) throw new Error("HEAD has no commit");
    const review: Review = { token: randomUUID(), head, branch };
    if (input.action === "reset") {
      await this.clean(p);
      review.target = await this.commitId(p, input.target);
      await git(p, ["merge-base", "--is-ancestor", review.target, head]);
      review.lost = await git(p, [
        "log",
        "--oneline",
        `${review.target}..${head}`,
      ]);
    } else if (input.action === "push") {
      if (!input.remotes?.length) throw new Error("Select at least one remote");
      review.remotes = {};
      review.mode = input.mode ?? "normal";
      for (const remote of new Set(input.remotes)) {
        await this.remote(p, remote);
        urls[remote] = await this.pushUrl(p, remote);
        const line = await git(p, [
          "ls-remote",
          "--refs",
          "--",
          urls[remote],
          `refs/heads/${branch}`,
        ]);
        review.remotes[remote] = line.trim().split(/\s/)[0] || "";
      }
    } else throw new Error("Unsupported review");
    if (head !== (await this.head(p)) || branch !== (await this.branch(p)))
      throw new Error("Repository changed during review");
    for (const [key, value] of this.reviews)
      if (value.expires < Date.now()) this.reviews.delete(key);
    this.reviews.set(review.token, {
      ...review,
      repo: p,
      expires: Date.now() + 300_000,
      kind: input.action,
      urls,
    });
    return review;
  }
  private async consume(p: string, input: OperationInput) {
    const r = this.reviews.get(input.review ?? "");
    this.reviews.delete(input.review ?? "");
    if (!r || r.repo !== p || r.kind !== input.action || r.expires < Date.now())
      throw new Error("Review expired; review and confirm again");
    if (r.head !== (await this.head(p)) || r.branch !== (await this.branch(p)))
      throw new Error("Reviewed HEAD or branch changed; review again");
    return r;
  }
  async execute(
    p: string,
    input: OperationInput,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await repository(p);
    switch (input.action) {
      case "switch": {
        await this.clean(p);
        if (input.tracking) {
          const n = await this.newBranch(p, input.name);
          const ref = safe(input.tracking, "tracking branch");
          await git(p, ["show-ref", "--verify", `refs/remotes/${ref}`]);
          await this.clean(p);
          return git(p, ["switch", "--track", "-c", n, ref]);
        }
        const n = await this.localBranch(p, input.name);
        await this.clean(p);
        return git(p, ["switch", "--", n]);
      }
      case "branch": {
        const n = await this.newBranch(p, input.name),
          oid = await this.commitId(p, input.target);
        if (input.switchAfter) await this.clean(p);
        await git(p, ["branch", n, oid]);
        if (input.switchAfter) {
          await this.clean(p);
          await git(p, ["switch", "--", n]);
        }
        return { branch: n };
      }
      case "orphan": {
        const n = await this.newBranch(p, input.name);
        const tree = (
          await git(p, ["hash-object", "-t", "tree", "-w", "--stdin"], {
            input: "",
          })
        ).trim();
        const oid = (
          await git(p, ["commit-tree", tree, "-m", "Initial commit"])
        ).trim();
        await git(p, [
          "update-ref",
          `refs/heads/${n}`,
          oid,
          "0".repeat(oid.length),
        ]);
        return { branch: n, oid };
      }
      case "reset": {
        const r = await this.consume(p, input);
        await this.clean(p);
        if ((await this.commitId(p, input.target)) !== r.target)
          throw new Error("Reset target changed");
        await git(p, ["merge-base", "--is-ancestor", r.target!, r.head]);
        if (input.backup) {
          const backup = await this.newBranch(p, input.backup);
          await git(p, [
            "update-ref",
            `refs/heads/${backup}`,
            r.head,
            "0".repeat(r.head.length),
          ]);
        }
        await this.clean(p);
        if (
          r.head !== (await this.head(p)) ||
          r.branch !== (await this.branch(p))
        )
          throw new Error("Repository changed before reset");
        return git(p, ["reset", "--hard", r.target!]);
      }
      case "merge": {
        await this.clean(p);
        await this.branch(p);
        const n = await this.localBranch(p, input.name);
        return git(p, ["merge", "--ff-only", "--", `refs/heads/${n}`]);
      }
      case "fetch": {
        const r = await this.remote(p, safe(input.name, "remote"));
        return git(p, ["fetch", "--progress", "--", r], {
          progress,
          signal,
          timeout: 600_000,
        });
      }
      case "push": {
        const r = await this.consume(p, input);
        if (
          r.mode !== (input.mode ?? "normal") ||
          JSON.stringify(Object.keys(r.remotes!).sort()) !==
            JSON.stringify([...new Set(input.remotes ?? [])].sort())
        )
          throw new Error("Push parameters changed; review again");
        const results = [];
        for (const remote of Object.keys(r.remotes!)) {
          try {
            await this.remote(p, remote);
            if (
              (await this.head(p)) !== r.head ||
              (await this.branch(p)) !== r.branch
            )
              throw new Error("Repository changed since review");
            const url = await this.pushUrl(p, remote);
            if (url !== r.urls[remote])
              throw new Error("Remote push URL changed; review again");
            if (input.mode === "lease" || input.mode === "force") {
              const current =
                (
                  await git(p, [
                    "ls-remote",
                    "--refs",
                    "--",
                    url,
                    `refs/heads/${r.branch}`,
                  ])
                )
                  .trim()
                  .split(/\s/)[0] || "";
              if (current !== r.remotes![remote])
                throw new Error("Reviewed remote branch changed; review again");
            }
            const args = [
              "push",
              "--progress",
              "--no-follow-tags",
              "--no-mirror",
            ];
            if (input.mode === "lease")
              args.push(
                `--force-with-lease=refs/heads/${r.branch}:${r.remotes![remote]}`,
              );
            if (input.mode === "force") args.push("--force");
            args.push("--", url, `${r.head}:refs/heads/${r.branch}`);
            progress?.(`Remote ${remote}\n`);
            const output = await git(p, args, {
              progress,
              signal,
              timeout: 600_000,
            });
            results.push({ remote, success: true, output });
          } catch (e) {
            const error = String(e);
            progress?.(`${remote}: ${error}\n`);
            results.push({ remote, success: false, error });
          }
        }
        return results;
      }
      case "stage":
      case "unstage": {
        if (!input.files?.length) throw new Error("Select files explicitly");
        for (const f of input.files)
          if (
            !f ||
            isAbsolute(f) ||
            f.split("/").includes("..") ||
            f.includes("\0")
          )
            throw new Error("Invalid file path");
        if (input.action === "stage")
          return git(p, ["add", "--", ...input.files]);
        return (await this.head(p))
          ? git(p, ["restore", "--staged", "--", ...input.files])
          : git(p, ["rm", "--cached", "--", ...input.files]);
      }
      case "commit": {
        if (!input.message?.trim())
          throw new Error("Commit message is required");
        return git(p, [
          "commit",
          ...(input.allowEmpty ? ["--allow-empty"] : []),
          "-m",
          input.message,
        ]);
      }
      default:
        throw new Error("Unsupported operation");
    }
  }
}
