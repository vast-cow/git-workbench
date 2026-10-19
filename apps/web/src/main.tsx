import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "./components/ui/button";
import type {
  OperationInput,
  Repository,
  Review,
  Operation,
} from "../../../packages/shared/src/index";
import "./style.css";
let token = sessionStorage.getItem("gitui-token") ?? "";
async function api<T = any>(url: string, data?: unknown): Promise<T> {
  const requestToken = token;
  const r = await fetch("/api" + url, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${requestToken}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await r.json();
  if (r.status === 401 && token === requestToken)
    window.dispatchEvent(new Event("gitui-locked"));
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}
function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <h2>{title}</h2>
      {children}
      <div className="row mt-5">
        <Button variant="outline" onClick={close}>
          Close
        </Button>
      </div>
    </dialog>
  );
}
function App() {
  const cache = useQueryClient();
  const [authenticated, setAuthenticated] = useState(!!token),
    [access, setAccess] = useState("");
  const [selected, setSelected] = useState<number>(),
    [tab, setTab] = useState("Overview"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"browse" | "clone" | null>(null),
    [directory, setDirectory] = useState("/"),
    [showHidden, setShowHidden] = useState(false),
    [cloneUrl, setCloneUrl] = useState(""),
    [destination, setDestination] = useState("");
  const [name, setName] = useState(""),
    [target, setTarget] = useState(""),
    [switchAfter, setSwitchAfter] = useState(false),
    [message, setMessage] = useState(""),
    [empty, setEmpty] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]),
    [mode, setMode] = useState<"normal" | "lease" | "force">("normal"),
    [backup, setBackup] = useState("");
  const [review, setReview] = useState<{
      data: Review;
      input: OperationInput;
      repo: number;
    }>(),
    [diff, setDiff] = useState<string>(),
    [live, setLive] = useState<Operation>(),
    [operation, setOperation] = useState<Operation>();
  const repos = useQuery<Repository[]>({
    queryKey: ["repositories"],
    queryFn: () => api("/repositories"),
    enabled: authenticated,
  });
  const repo = useQuery({
    queryKey: ["repo", selected],
    queryFn: () => api(`/repositories/${selected}`),
    enabled: authenticated && !!selected,
    refetchInterval: 5000,
  });
  const history = useQuery<Operation[]>({
    queryKey: ["operations"],
    queryFn: () => api("/operations"),
    enabled: authenticated,
    refetchInterval: 3000,
  });
  const dirs = useQuery({
    queryKey: ["directories", directory],
    queryFn: () => api("/directories?path=" + encodeURIComponent(directory)),
    enabled: authenticated && modal === "browse",
  });
  const visibleDirectories = (dirs.data?.directories ?? []).filter(
    (d: { name: string }) => showHidden || !d.name.startsWith("."),
  );
  useEffect(() => {
    setRemotes([]);
    setTarget("");
    setReview(undefined);
  }, [selected]);
  useEffect(() => {
    const lock = () => {
      token = "";
      sessionStorage.removeItem("gitui-token");
      setAuthenticated(false);
      setAccess("");
      setSelected(undefined);
      setModal(null);
      setReview(undefined);
      cache.clear();
    };
    window.addEventListener("gitui-locked", lock);
    return () => window.removeEventListener("gitui-locked", lock);
  }, [cache]);
  async function act(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await cache.invalidateQueries();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function watch(id: string) {
    const response = await fetch(`/api/operations/${id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok || !response.body)
      throw new Error("Cannot open operation progress");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith("data: ")) {
            const row = JSON.parse(event.slice(6));
            setLive(row);
            if (row.error) setError(row.error);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const run = (input: OperationInput, id = selected) =>
    act(async () => {
      const job = await api(`/repositories/${id}/operations`, input);
      await watch(job.id);
    });
  async function prepare(input: OperationInput) {
    await act(async () =>
      setReview({
        data: await api(`/repositories/${selected}/review`, input),
        input,
        repo: selected!,
      }),
    );
  }
  if (!authenticated)
    return (
      <main className="max-w-xl mx-auto pt-24">
        <h1>Git Workbench</h1>
        <p className="muted my-4">
          Local repository management. Enter the access token printed in your
          server terminal.
        </p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              token = access.trim();
              await api("/session");
              sessionStorage.setItem("gitui-token", token);
              setAuthenticated(true);
            });
          }}
        >
          <label htmlFor="access">Access token</label>
          <input
            id="access"
            type="password"
            value={access}
            onChange={(e) => setAccess(e.target.value)}
            autoComplete="off"
          />
          <Button disabled={busy}>Unlock</Button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    );
  const r = repo.data;
  const remoteNames = [
    ...new Set<string>(
      (r?.remotes ?? "")
        .split("\n")
        .filter(Boolean)
        .map((s: string) => s.split(/\s/)[0]),
    ),
  ];
  return (
    <div className="layout">
      <aside>
        <div className="text-xl font-semibold">◈ Git Workbench</div>
        <p className="text-xs opacity-60 mt-1 mb-8">LOCAL REPOSITORIES</p>
        {repos.data?.map((p) => (
          <Button
            key={p.id}
            variant={p.id === selected ? "default" : "outline"}
            className={p.id === selected ? "" : "text-slate-800"}
            onClick={() => setSelected(p.id)}
          >
            {p.path.split("/").pop()}
          </Button>
        ))}
        {!repos.data?.length && (
          <p className="text-sm opacity-70">No repositories registered.</p>
        )}
        <div className="mt-8">
          <Button
            onClick={() => {
              setModal("browse");
              setShowHidden(false);
              void act(async () => {
                const s = await api("/session");
                setDirectory(s.home);
              });
            }}
          >
            Open repository
          </Button>
          <Button onClick={() => setModal("clone")}>Clone repository</Button>
          <Button
            onClick={() => window.dispatchEvent(new Event("gitui-locked"))}
          >
            Lock session
          </Button>
        </div>
        <p className="text-xs opacity-60 mt-8">
          Git remains the source of truth.
          <br />
          Local changes stay under your control.
        </p>
      </aside>
      <main>
        <header className="row justify-between">
          <div>
            <p className="muted">REPOSITORY WORKSPACE</p>
            <h1>{r?.path.split("/").pop() ?? "Your repositories"}</h1>
            <p className="muted break-all">
              {r?.path ??
                "Open an existing repository or clone one to get started."}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => void cache.invalidateQueries()}
          >
            Refresh
          </Button>
        </header>
        {(error || repos.error || repo.error) && (
          <div role="alert" className="error">
            {error || String(repos.error || repo.error)}
          </div>
        )}
        {selected && repo.isLoading && (
          <p className="card">Reading repository…</p>
        )}
        {r && (
          <>
            <div className="row mt-5">
              <span className="badge">{r.branch}</span>
              <code>{r.head.slice(0, 12) || "No commits yet"}</code>
              <span className="muted">
                {r.files.length
                  ? `${r.files.length} changed files`
                  : "Clean working tree"}
              </span>
              {busy && <span>Operation in progress…</span>}
            </div>
            <nav className="tabs">
              {[
                "Overview",
                "Branches",
                "History",
                "Remotes",
                "Changes",
                "Operations",
              ].map((t) => (
                <Button
                  key={t}
                  variant={t === tab ? "default" : "outline"}
                  onClick={() => setTab(t)}
                >
                  {t}
                </Button>
              ))}
            </nav>
            {tab === "Overview" && (
              <>
                <section className="card">
                  <h2>Repository status</h2>
                  <pre>{r.status}</pre>
                </section>
                <section className="card">
                  <h2>Remotes</h2>
                  <pre>{r.remotes || "No configured remotes"}</pre>
                  <h2 className="mt-5">Linked worktrees</h2>
                  <pre>{r.worktrees}</pre>
                </section>
              </>
            )}
            {tab === "Branches" && (
              <>
                <section className="card">
                  <h2>Branches</h2>
                  {r.branches.map((b: any) => (
                    <div key={b.ref} className="item row justify-between">
                      <div>
                        <strong>{b.name}</strong>{" "}
                        {b.name === r.branch && !b.remote && (
                          <span className="badge">current</span>
                        )}
                        <p className="muted">
                          {b.remote
                            ? "Remote-tracking"
                            : b.worktree
                              ? `Checked out: ${b.worktree}`
                              : "Local"}{" "}
                          {b.upstream} {b.tracking}
                        </p>
                      </div>
                      <div className="row">
                        {b.remote ? (
                          <Button
                            disabled={busy || !name}
                            onClick={() =>
                              void run({
                                action: "switch",
                                name,
                                tracking: b.name,
                              })
                            }
                          >
                            Track as {name || "branch name below"}
                          </Button>
                        ) : (
                          <>
                            <Button
                              disabled={
                                busy || !!r.files.length || !!b.worktree
                              }
                              onClick={() =>
                                void run({ action: "switch", name: b.name })
                              }
                            >
                              Switch
                            </Button>
                            <Button
                              variant="outline"
                              disabled={
                                busy || !!r.files.length || b.name === r.branch
                              }
                              onClick={() =>
                                void run({ action: "merge", name: b.name })
                              }
                            >
                              Merge ff-only
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {r.files.length > 0 && (
                    <p className="muted mt-3">
                      Switch and merge require a clean working tree, including
                      untracked files.
                    </p>
                  )}
                </section>
                <section className="card stack">
                  <h2>Create a branch</h2>
                  <label>
                    Branch name
                    <input
                      aria-label="Branch name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    Commit ID
                    <input
                      aria-label="Branch commit"
                      placeholder={r.head || "Commit ID"}
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={switchAfter}
                      onChange={(e) => setSwitchAfter(e.target.checked)}
                    />
                    Switch after creating from commit
                  </label>
                  <div className="row">
                    <Button
                      disabled={busy || !name}
                      onClick={() =>
                        void run({
                          action: "branch",
                          name,
                          target: target || r.head,
                          switchAfter,
                        })
                      }
                    >
                      Create from commit
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !name}
                      onClick={() => void run({ action: "orphan", name })}
                    >
                      Create empty orphan
                    </Button>
                  </div>
                  <p className="muted">
                    Orphan creation leaves this worktree untouched and creates
                    an empty root commit named “Initial commit”.
                  </p>
                </section>
              </>
            )}
            {tab === "History" && (
              <section className="card">
                <h2>
                  Commit history{" "}
                  <span className="muted">Latest 100 commits</span>
                </h2>
                {!r.history.length && <p>No commits yet.</p>}
                {r.history.map((c: any) => (
                  <div className="item" key={c.oid}>
                    <div className="row justify-between">
                      <strong>{c.message}</strong>
                      <div className="row">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void act(async () =>
                              setDiff(
                                (
                                  await api(
                                    `/repositories/${selected}/commit?commit=${c.oid}`,
                                  )
                                ).diff,
                              ),
                            )
                          }
                        >
                          Details
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void prepare({ action: "reset", target: c.oid })
                          }
                        >
                          Review reset
                        </Button>
                      </div>
                    </div>
                    <p className="muted">
                      <code>{c.oid}</code> · {c.author} ·{" "}
                      {new Date(c.date).toLocaleString()}
                    </p>
                  </div>
                ))}
                <div className="row mt-5">
                  <input
                    aria-label="Reset target"
                    placeholder="Target commit ID"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                  <Button
                    disabled={busy || !target}
                    onClick={() => void prepare({ action: "reset", target })}
                  >
                    Review hard reset
                  </Button>
                </div>
              </section>
            )}
            {tab === "Remotes" && (
              <section className="card stack">
                <h2>Remote operations</h2>
                <pre>
                  {r.remotes ||
                    "No remotes configured. Configure remotes with Git first."}
                </pre>
                {remoteNames.map((n) => (
                  <div className="row" key={n}>
                    <label>
                      <input
                        type="checkbox"
                        checked={remotes.includes(n)}
                        onChange={(e) =>
                          setRemotes(
                            e.target.checked
                              ? [...remotes, n]
                              : remotes.filter((v) => v !== n),
                          )
                        }
                      />
                      {n}
                    </label>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run({ action: "fetch", name: n })}
                    >
                      Fetch {n}
                    </Button>
                  </div>
                ))}
                <div className="row">
                  <Button
                    variant="outline"
                    onClick={() => setRemotes(remoteNames)}
                  >
                    Select all remotes
                  </Button>
                  <Button variant="outline" onClick={() => setRemotes([])}>
                    Clear selection
                  </Button>
                </div>
                <label>
                  Push mode
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as typeof mode)}
                  >
                    <option value="normal">Normal push</option>
                    <option value="lease">
                      Force with lease (preferred force mode)
                    </option>
                    <option value="force">
                      Force — overwrite remote history
                    </option>
                  </select>
                </label>
                <p className="muted">
                  Push {r.branch} to the same branch name on each selected
                  remote. Each result is recorded separately.
                </p>
                <Button
                  disabled={busy || !remotes.length}
                  onClick={() =>
                    void prepare({ action: "push", remotes, mode })
                  }
                >
                  Review push
                </Button>
              </section>
            )}
            {tab === "Changes" && (
              <section className="card">
                <h2>Changes and commits</h2>
                {!r.files.length && (
                  <p className="muted">Working tree is clean.</p>
                )}
                {r.files.map((f: any) => (
                  <div className="item row justify-between" key={f.path}>
                    <code>
                      {f.index}
                      {f.worktree} {f.original ? `${f.original} → ` : ""}
                      {f.path}
                    </code>
                    <div className="row">
                      <Button
                        size="sm"
                        disabled={busy || f.worktree === " "}
                        onClick={() =>
                          void run({
                            action: "stage",
                            files: [
                              f.path,
                              ...(f.original ? [f.original] : []),
                            ],
                          })
                        }
                      >
                        Stage
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || f.index === " " || f.index === "?"}
                        onClick={() =>
                          void run({
                            action: "unstage",
                            files: [
                              f.path,
                              ...(f.original ? [f.original] : []),
                            ],
                          })
                        }
                      >
                        Unstage
                      </Button>
                    </div>
                  </div>
                ))}
                <details className="mt-4">
                  <summary>Staged diff</summary>
                  <pre>{r.staged || "No staged diff"}</pre>
                </details>
                <details>
                  <summary>Unstaged diff</summary>
                  <pre>
                    {r.unstaged ||
                      "No tracked unstaged diff. Untracked file content is not shown."}
                  </pre>
                </details>
                <form
                  className="stack mt-6"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run({ action: "commit", message, allowEmpty: empty });
                  }}
                >
                  <label htmlFor="message">Commit message</label>
                  <textarea
                    id="message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    required
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={empty}
                      onChange={(e) => setEmpty(e.target.checked)}
                    />
                    Allow empty commit (staged changes are still included)
                  </label>
                  <Button disabled={busy || !message.trim()}>
                    Create commit
                  </Button>
                </form>
              </section>
            )}
          </>
        )}
        {(tab === "Operations" || !r) && (
          <section className="card">
            <h2>Operation history</h2>
            {!history.data?.length && (
              <p className="muted">No operations yet.</p>
            )}
            {history.data?.map((o) => (
              <div className="item row justify-between" key={o.id}>
                <div>
                  <strong>{o.type}</strong>{" "}
                  <span className="badge">{o.status}</span>
                  <p className="muted">
                    {new Date(o.started).toLocaleString()} · {o.repo} ·{" "}
                    {o.duration ?? "…"} ms
                  </p>
                </div>
                <Button variant="outline" onClick={() => setOperation(o)}>
                  Inspect
                </Button>
              </div>
            ))}
          </section>
        )}
        {live && (
          <section className="card">
            <div className="row justify-between">
              <h2>
                {live.type}: {live.status}
              </h2>
              {live.status === "running" && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void api(`/operations/${live.id}/cancel`, {}).catch((e) =>
                      setError(String(e)),
                    )
                  }
                >
                  Cancel
                </Button>
              )}
            </div>
            <pre>{live.output || "Waiting for Git…"}</pre>
            {live.error && <p className="error">{live.error}</p>}
          </section>
        )}
        {modal === "browse" && (
          <Dialog title="Open local repository" close={() => setModal(null)}>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                setDirectory(String(form.get("path")));
              }}
            >
              <input
                aria-label="Directory path"
                name="path"
                key={directory}
                defaultValue={directory}
              />
              <Button>Browse</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setModal(null)}
              >
                Cancel
              </Button>
            </form>
            <label className="row my-4">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              Show hidden files
            </label>
            {dirs.isLoading && <p>Loading directories…</p>}
            {dirs.error && <p className="error">{String(dirs.error)}</p>}
            {dirs.data && (
              <>
                <div className="row my-4">
                  <Button
                    variant="outline"
                    onClick={() => setDirectory(dirs.data.parent)}
                  >
                    Parent directory
                  </Button>
                  <Button
                    disabled={!dirs.data.isRepository || busy}
                    onClick={() =>
                      void act(async () => {
                        const p = await api("/repositories", {
                          path: directory,
                        });
                        setSelected(p.id);
                        setModal(null);
                      })
                    }
                  >
                    Register this repository
                  </Button>
                </div>
                <p className="muted break-all">{dirs.data.path}</p>
                {visibleDirectories.map((d: any) => (
                  <div className="item" key={d.path}>
                    <Button
                      variant="outline"
                      onClick={() => setDirectory(d.path)}
                    >
                      {d.name}
                    </Button>{" "}
                    {d.isRepository && (
                      <span className="badge">Git repository</span>
                    )}
                  </div>
                ))}
                {!visibleDirectories.length && <p>No subdirectories.</p>}
              </>
            )}
          </Dialog>
        )}
        {modal === "clone" && (
          <Dialog title="Clone repository" close={() => setModal(null)}>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const job = await api("/clone", {
                    url: cloneUrl,
                    destination,
                  });
                  setModal(null);
                  await watch(job.id);
                });
              }}
            >
              <label>
                Git URL
                <input
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  required
                />
              </label>
              <label>
                Absolute destination
                <input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  required
                />
              </label>
              <p className="muted">
                The parent must exist. An existing destination is never reused.
                Your existing Git/SSH credentials are used.
              </p>
              <Button disabled={busy}>Clone</Button>
            </form>
          </Dialog>
        )}
        {review && (
          <Dialog
            title={
              review.input.action === "reset"
                ? "Confirm hard reset"
                : "Confirm push"
            }
            close={() => setReview(undefined)}
          >
            <p>
              Current branch: <strong>{review.data.branch}</strong>
            </p>
            <p className="break-all">
              Reviewed HEAD: <code>{review.data.head}</code>
            </p>
            {review.input.action === "reset" ? (
              <>
                <p className="break-all">
                  Target: <code>{review.data.target}</code>
                </p>
                <h3 className="mt-4">Commits removed from this branch</h3>
                <pre>{review.data.lost || "None (already at target)"}</pre>
                <label>
                  Optional backup branch
                  <input
                    value={backup}
                    onChange={(e) => setBackup(e.target.value)}
                    placeholder="backup/before-reset"
                  />
                </label>
              </>
            ) : (
              <>
                <p
                  className={review.input.mode === "normal" ? "muted" : "error"}
                >
                  {review.input.mode === "normal"
                    ? "Normal push."
                    : "Remote history may be overwritten. Force with lease rejects a changed remote ref; unconditional force does not protect against remote races."}
                </p>
                <pre>
                  {Object.entries(review.data.remotes ?? {})
                    .map(
                      ([n, oid]) =>
                        `${n}: refs/heads/${review.data.branch}\nReviewed remote: ${oid || "(new branch)"}`,
                    )
                    .join("\n")}
                </pre>
              </>
            )}
            <p className="muted my-4">
              Confirmation expires in five minutes. A changed local HEAD
              requires a new review.
            </p>
            <Button
              variant={
                review.input.action === "reset" ||
                review.input.mode !== "normal"
                  ? "destructive"
                  : "default"
              }
              disabled={busy}
              onClick={() => {
                const current = review;
                setReview(undefined);
                void run(
                  {
                    ...current.input,
                    review: current.data.token,
                    ...(current.input.action === "reset" && backup
                      ? { backup }
                      : {}),
                  },
                  current.repo,
                );
              }}
            >
              Confirm {review.input.action}
            </Button>
          </Dialog>
        )}
        {diff !== undefined && (
          <Dialog title="Commit details" close={() => setDiff(undefined)}>
            <pre>{diff}</pre>
          </Dialog>
        )}
        {operation && (
          <Dialog
            title="Operation details"
            close={() => setOperation(undefined)}
          >
            <pre>
              {JSON.stringify(
                history.data?.find((o) => o.id === operation.id) ?? operation,
                null,
                2,
              )}
            </pre>
          </Dialog>
        )}
      </main>
    </div>
  );
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
