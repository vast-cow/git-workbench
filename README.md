# Git Workbench

A single-user Linux Git management UI. React/TypeScript, Vite, Tailwind, a shadcn-style Radix Button, and TanStack Query provide the frontend; Fastify, TypeBox, Git CLI, SQLite, and Drizzle provide the backend. No hosted service or credential database is needed.

## Install and run on Linux with npx

Requirements: Git, Node.js **24.x**, and a browser. Use `npx` (included with npm) to run the pinned pnpm version; a global pnpm installation is unnecessary. This repository is a private workspace with no executable `bin` entry, so the commands below install and run a local checkout through pnpm, rather than downloading Git Workbench as a standalone npm CLI.

### 1. Install Node.js 24

On Debian/Ubuntu, install Git and curl first (use your distribution's package manager on other Linux systems):

```sh
sudo apt update
sudo apt install -y git curl ca-certificates
```

Install [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) in Bash, then install and select Node.js 24:

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
nvm use 24
node --version
npm --version
npx --version
```

`node --version` should print `v24.x.x`. The project requires `>=24 <25`; use `24` explicitly instead of an unpinned latest release. See the [Node.js download page](https://nodejs.org/en/download) for other installation methods. If nvm is already installed in a custom directory, load that installation instead of resetting `NVM_DIR`. In a new terminal, run `nvm use 24` if another Node.js version is active.

### 2. Install dependencies and build

Clone or download this repository and open a terminal in its root directory (the directory containing `package.json` and `pnpm-workspace.yaml`). Then run:

```sh
npx --yes pnpm@10.28.2 install --frozen-lockfile
npx --yes pnpm@10.28.2 build
```

[npx](https://docs.npmjs.com/cli/v11/commands/npx/) downloads pnpm into npm's cache when needed; pnpm installs the workspace dependencies locally. `--yes` accepts npx's package installation prompt. Initial setup requires internet access.

SQLite's native module normally installs a prebuilt binary. If none is available for your platform, install Python 3, make, and a C++ compiler, then retry the dependency installation. On Debian/Ubuntu:

```sh
sudo apt install -y python3 build-essential
npx --yes pnpm@10.28.2 install --frozen-lockfile
```

### 3. Start Git Workbench

Configure your Git author identity and SSH keys/credential helper as usual, then run from the repository root:

```sh
NODE_ENV=production npx --yes pnpm@10.28.2 start
```

Open **http://127.0.0.1:4317**. No access token is required by default. Use the numeric loopback address, not `localhost`. Stop the server with **Ctrl+C**; use the same command to start it again. Keep the checkout, built frontend assets, and workspace dependencies installed: the server runs TypeScript through `tsx` and serves the built frontend through Fastify.

To use a different port:

```sh
PORT=4320 NODE_ENV=production npx --yes pnpm@10.28.2 start
```

Open **http://127.0.0.1:4320** for this example.

### Data storage

Metadata and audit records live under `$XDG_DATA_HOME/git-webui` (default `~/.local/share/git-webui`). Override with an absolute `GITUI_DATA_DIR`, for example:

```sh
GITUI_DATA_DIR="$HOME/.local/share/git-workbench" NODE_ENV=production npx --yes pnpm@10.28.2 start
```

The data directory is created with mode `0700`. No repositories are scanned or registered on startup. A failed clone leaves its newly created destination for inspection; remove it manually before retrying.

## Development

After installing dependencies, run from the repository root:

```sh
npx --yes pnpm@10.28.2 dev
```

Open **http://127.0.0.1:5173** locally, or **http://<server-ip>:5173** from another device. Vite listens on **0.0.0.0:5173** by default. The backend listens on **127.0.0.1:4317**, with Vite proxying `/api`. Development expects the default backend port. After changing the source, rebuild before using the production start command.

## Workflows

- **Open repository:** browse one directory level at a time or enter an absolute path, navigate into a repository, then register it. Git validates repository roots, including linked worktrees with `.git` files. Choose a registered repository in the sidebar.
- **Overview:** inspect HEAD, branch, status/ahead-behind, remotes and worktrees.
- **Branches:** switch clean local branches, create a branch from a commit, create an empty orphan, or merge a local branch with `--ff-only`. To track a remote branch, enter a new local branch name and use its Track button. Branches checked out in another worktree cannot be switched into.
- **History:** inspect commit details/diffs or review an ancestry-restricted hard reset. The confirmation shows current HEAD, target, and commits removed from that branch; optionally enter a new backup branch. Commits may remain reachable from other refs.
- **Remotes:** fetch individually; select one, several, or all remotes and review a push. Normal push is the default. Force-with-lease is the preferred force mode. Reviews show each destination branch and expected remote OID. Each remote result is recorded separately.
- **Changes:** stage/unstage individual files and commit with a message. Allow-empty permits a commit without staged changes; if changes are staged, they are still committed. No automatic staging or amend.
- **Operations:** inspect parameters, before/after HEAD, output, errors, duration and results. Clone/fetch/push stream Git progress. Running remote operations can be cancelled; cancellation cannot undo a push already accepted remotely.

## Architecture and safety

- `packages/shared/src/index.ts`: shared operation/review/record types.
- `apps/server/src/git.ts`: explicit Git operations, repository discovery, subprocess lifecycle, clean-tree checks, and per-common-Git-directory mutation queues. Git is always the source of truth; SQLite does not cache branch state.
- `apps/server/src/app.ts`: TypeBox-validated Fastify routes, process-local expiring review tokens, SSE streams, operation lifecycle, and local browser protection. APIs do not require an access token by default; callers that pass an explicit `token` to `createApp` enable bearer-token enforcement. Origin headers are unrestricted; Host validation and Fetch Metadata checks remain enabled, and requests marked cross-site are rejected.
- `apps/server/src/db.ts` and `migrations/0001.sql`: Drizzle schema plus the versioned, idempotent initial SQLite migration. WAL and a busy timeout support audit writes. Records left running after a server interruption are marked interrupted on restart. The UI shows the latest 200 records; older records remain in SQLite.
- `apps/web/src`: React views, shared button and style utilities, query refresh, fetch-based SSE, and modal confirmations. API data is rendered as text, not HTML.

Git commands use `spawn` with argument arrays, no shell, literal pathspecs, bounded output, timeouts, and process-group cancellation on Linux. Diff viewers disable external diff/textconv execution. Git hooks, signing, SSH and credential helpers remain the user's Git configuration; interactive terminal prompting is disabled. Signing/SSH requiring interactive input may fail or time out. URLs containing userinfo and common token query parameters are redacted from audit output. Do not put credentials in URLs or commit messages; use your credential helper instead. This application is for repositories/configuration you trust.

Orphan creation writes an empty tree with `hash-object`, creates a parentless commit with `commit-tree`, and atomically creates its ref with `update-ref` and an expected zero old value. It never changes the active index or working tree.

Reset requires an attached branch, a clean tree including untracked files, and a target ancestor of HEAD. A five-minute, single-use review binds the branch, HEAD and resolved target. Backup creation must succeed before reset; it never overwrites a ref. State is re-read immediately before resetting. Failed mutations are recorded as well as successes.

Push review binds the local HEAD, branch, mode, selected remotes, push URLs and observed destination OIDs. A remote with multiple push URLs is rejected; configure separate remotes instead. Pushes use the reviewed commit OID and explicit single-branch refspec, with mirror and follow-tags disabled. Force modes recheck the remote ref, and force-with-lease additionally supplies the exact reviewed expected OID to Git for server-side protection. Unconditional force still has an inherent remote race after the check. Normal pushes rely on Git's fast-forward protection. Partial failures retain all individual results.

## Validation

Run from the repository root after installing dependencies:

```sh
npx --yes pnpm@10.28.2 check
npx --yes pnpm@10.28.2 test
npx --yes pnpm@10.28.2 build
npx --yes pnpm@10.28.2 exec playwright install chromium
npx --yes pnpm@10.28.2 test:ui
```

Vitest uses disposable repositories and local bare remotes only. Tests cover cloning/detection/worktrees, branch and orphan creation, dirty-tree protection, ancestry/reset/backup/stale-review checks, ff-only merges, literal-path staging, empty commits, normal/lease/force/partial pushes, queue recovery, HTTP protection, audit records and SSE. Playwright starts its own server and temporary repository, then exercises branch creation, empty commit, reset confirmation with backup, audit browsing and the directory browser. Browser dependencies may need installation through your Linux distribution or `npx --yes pnpm@10.28.2 exec playwright install --with-deps chromium`.

## Limits

- External Git clients do not participate in the application queue. Immediate revalidation and Git's native locks catch many conflicts, but no multi-command filesystem workflow can be atomic against arbitrary external edits. Avoid simultaneous external writes during reset/switch/merge. An optional reset backup is strongly recommended; it protects the original commit, not external uncommitted edits.
- Repository status refreshes every five seconds; use Refresh after external activity. Ahead/behind uses the last fetched tracking refs.
- History is limited to 100 commits per view; diffs have an 8 MB output limit. Large repositories/directories may be slow to inspect. No recursive filesystem discovery or symlink-directory traversal is performed.
- Bare repositories can be clone/push sources but cannot be registered as working repositories. Submodules are shown through Git status; no dedicated submodule management is included.
- Audit output retains the last 100 KB per operation. There is no audit export, pruning UI or credential vault. Restart invalidates pending confirmations. Single backend process only.
- No rebase, cherry-pick, amend, conflict resolution, remote editing, code editing, force checkout, arbitrary Git command API, multi-user access, TLS or cloud hosting.
