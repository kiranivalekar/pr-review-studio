<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:6366f1,50:8b5cf6,100:ec4899&height=180&section=header&text=PR%20Review%20Studio&fontColor=ffffff&fontSize=46&fontAlignY=36&desc=Review%20GitHub%20PRs%20with%20Claude%20Code&descSize=16&descAlignY=57&animation=fadeIn" alt="PR Review Studio" />

<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=19&pause=1200&color=8B5CF6&center=true&vCenter=true&width=640&lines=See+what's+waiting+on+your+review.;Run+an+AI+pass+over+the+diff.;Edit+and+curate+every+comment.;Push+only+what+you+approve%2C+inline." alt="See what's waiting - run an AI pass - curate - push inline" />

<br/>

<img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
<img src="https://img.shields.io/badge/Vite-5-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite 5" />
<img src="https://img.shields.io/badge/Tailwind-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind 4" />
<img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
<img src="https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code" />

<img src="https://img.shields.io/badge/runs-100%25_local-22c55e?style=flat-square&logo=homeassistant&logoColor=white" alt="Runs fully local" />
<img src="https://img.shields.io/badge/store-data%2Fdb.json-64748b?style=flat-square&logo=json&logoColor=white" alt="JSON store" />
<img src="https://img.shields.io/badge/API-%3A3011-3b82f6?style=flat-square&logo=fastapi&logoColor=white" alt="API on 3011" />
<img src="https://img.shields.io/badge/UI-%3A5173-10b981?style=flat-square&logo=vite&logoColor=white" alt="UI on 5173" />
<img src="https://img.shields.io/badge/theme-dark%20%C2%B7%20light%20%C2%B7%20system-a855f7?style=flat-square&logo=windowterminal&logoColor=white" alt="Theme support" />

</div>

<div align="center">

### 🧭 &nbsp;Jump to

[**💡 What is this**](#-what-is-this) &nbsp;·&nbsp;
[**✨ Features**](#-features) &nbsp;·&nbsp;
[**🌊 Whole flow**](#-the-whole-flow) &nbsp;·&nbsp;
[**🏗 Architecture**](#-architecture) &nbsp;·&nbsp;
[**🎚 Review modes**](#-review-modes) &nbsp;·&nbsp;
[**🚀 Quick start**](#-quick-start) &nbsp;·&nbsp;
[**⚙️ Configuration**](#️-configuration) &nbsp;·&nbsp;
[**🛰 API**](#-api-surface) &nbsp;·&nbsp;
[**🗃 Data model**](#-data-model) &nbsp;·&nbsp;
[**🩺 Troubleshooting**](#-troubleshooting) &nbsp;·&nbsp;
[**🗺 Roadmap**](#-roadmap)

</div>

---

## 💡 &nbsp;What is this?

> A **local, single-user web app** for reviewing GitHub pull requests with Claude Code.
>
> It surfaces the PRs waiting on your review, runs an AI pass over the diff, lets you
> **edit and curate** every suggested comment, then pushes only the ones you approve — as a
> **real inline GitHub review**, complete with native *Apply suggestion* buttons.

<table>
<tr>
<td width="33%" valign="top">

#### 🔒 &nbsp;Yours alone
No hosting, no accounts, no telemetry. Runs on `localhost`, keeps everything in one JSON file.

</td>
<td width="33%" valign="top">

#### 🎛 &nbsp;You stay in control
Nothing reaches GitHub until you tick the boxes and press **Push**. Automation never pushes.

</td>
<td width="33%" valign="top">

#### 🧠 &nbsp;Context-aware
Local clones, linked PRs, dependency manifests and PHPStan config all feed the review.

</td>
</tr>
</table>

---

## ✨ &nbsp;Features

| | Feature | What you get |
|:--:|---|---|
| 📥 | **Assigned PRs** | Every PR where you're a requested reviewer, plus any added by URL — grouped into collapsible per-repo accordion sections with `unreviewed` / `reviewed` / `commented` status and diffstat gutters. |
| 🔍 | **GitHub-style diff** | Unified **and** split view, a collapsible file tree with `+N`/`-N` counts, per-file collapse, and *"show more lines"* hunk expansion in both directions. |
| 💬 | **Inline AI comments** | Findings render **on the exact line they target**, with severity (`nit` · `suggestion` · `issue` · `blocking`) and a green *Suggested change* block. Commented lines get their own accent highlight. |
| ✏️ | **Fully editable** | Rewrite the text, change the severity, tweak the suggested code, or dismiss a comment — nothing is published until you say so. |
| 🚀 | **One-click push** | Selected comments go up as a single atomic GitHub review: line-attached comments plus native ` ```suggestion ` blocks. Unplaceable comments land in the review body instead of being dropped. |
| 🎚 | **Three review modes** | `Diff only` · `Curated context` · `Deep review` — pick your cost/depth trade-off per run. [See below.](#-review-modes) |
| 📚 | **Review write-up** | Each run stores a prose summary, rendered as markdown with syntax highlighting above the diff. |
| ☑️ | **Review checklist** | A stack-aware checklist (`common` / `frontend` / `backend`) driven by `server/review_config.json`, answered per run. |
| 🔗 | **Linked PRs** | Attach dependent PRs (frontend ↔ backend, app ↔ shared lib) so the review checks **cross-PR consistency** without reviewing the other PR's own code. |
| ⚡ | **Batch review** | Select several PRs inside one repo group and review them all — diff-only, max 3 concurrent, deliberately predictable in cost and time. |
| 📦 | **Dependency awareness** | Reads `package.json` / `composer.json` at the PR's head SHA so comments reason about your *actual* versions — and flag code reinventing a library you already ship. |
| 🐘 | **PHPStan awareness** | Picks up `phpstan.neon(.dist)` so PHP comments match your enforced level and ignored rules instead of a generic stricter standard. |
| 📊 | **Usage meter** | Today's token spend and review count, derived from the day's runs — naturally resets at local midnight, no reset button needed. |
| 🌗 | **Dark / light / system** | Theme toggle persisted in `localStorage`, following the OS by default. |
| 📂 | **Safe worktrees** | Deep reviews run inside a disposable `git worktree` of the PR's head ref — your clone's branch and uncommitted work are never touched. |

---

## 🌊 &nbsp;The whole flow

Everything the app does, end to end — from the PR list to a live GitHub review.

```mermaid
flowchart TD
    subgraph L1["📥 &nbsp;1 · Discover"]
        direction LR
        A1["🐙 GitHub search<br/><i>review-requested:me</i>"]
        A2["🔗 Add PR by URL<br/><i>manual source</i>"]
        A3["📋 Assigned PRs<br/><i>grouped by repo · status badges</i>"]
        A1 --> A3
        A2 --> A3
    end

    subgraph L2["🔎 &nbsp;2 · Open"]
        direction LR
        B1["📄 Unified diff<br/><i>parseDiff.js</i>"]
        B2["🌳 File tree<br/><i>+N / -N diffstat</i>"]
        B3["↔️ Unified · Split<br/><i>hunk expansion</i>"]
        B1 --> B2 --> B3
    end

    subgraph L3["🧩 &nbsp;3 · Gather context"]
        direction LR
        C1["🎚 Mode<br/><i>diff · curated · deep</i>"]
        C2["📂 git worktree<br/><i>LOCAL_REPOS_ROOT</i>"]
        C3["🔗 Linked PR diffs<br/><i>capped, truncated</i>"]
        C4["📦 package.json<br/>composer.json"]
        C5["🐘 phpstan.neon"]
    end

    subgraph L4["🤖 &nbsp;4 · Review"]
        direction LR
        D1["🤖 claude CLI<br/><i>headless -p · stdin</i>"]
        D2["🧱 Per-file batching<br/><i>token-budgeted</i>"]
        D3["🧾 JSON schema<br/><i>structured_output</i>"]
        D1 --> D2 --> D3
    end

    subgraph L5["✏️ &nbsp;5 · Curate"]
        direction LR
        E1["💬 Inline comments<br/><i>on the target line</i>"]
        E2["📚 Write-up<br/>☑️ Checklist"]
        E3["✏️ Edit · severity<br/>🗑 Dismiss · ✅ Select"]
        E1 --> E3
        E2 --> E3
    end

    subgraph L6["🚀 &nbsp;6 · Publish"]
        direction LR
        F1["🚀 POST push<br/><i>chosen ids only</i>"]
        F2["🐙 Inline GitHub review<br/><i>Apply suggestion buttons</i>"]
        F3["🏷 status → commented"]
        F1 --> F2 --> F3
    end

    A3 -->|"open a PR"| B1
    A3 -.->|"⚡ batch review<br/>diff-only · max 3"| D1
    B3 -->|"▶️ Run review"| C1
    C1 --> D1
    C2 --> D1
    C3 --> D1
    C4 --> D1
    C5 --> D1
    D3 -->|"💾 store run"| DB[("🗃️ data/db.json<br/><i>prs · reviews · comments</i>")]
    DB --> E1
    E3 --> F1
    F3 --> DB
    D3 -.->|"📊 tokens + cost"| U["📊 Usage meter<br/><i>today only</i>"]

    classDef s1 fill:#1e1b4b,stroke:#818cf8,stroke-width:2px,color:#eef2ff
    classDef s2 fill:#0c4a6e,stroke:#38bdf8,stroke-width:2px,color:#f0f9ff
    classDef s3 fill:#134e4a,stroke:#2dd4bf,stroke-width:2px,color:#f0fdfa
    classDef s4 fill:#4c1d24,stroke:#fb7185,stroke-width:2px,color:#fff1f2
    classDef s5 fill:#422006,stroke:#fbbf24,stroke-width:2px,color:#fffbeb
    classDef s6 fill:#14532d,stroke:#4ade80,stroke-width:2px,color:#f0fdf4
    classDef store fill:#7c2d12,stroke:#fb923c,stroke-width:3px,color:#fff7ed
    classDef meter fill:#3b0764,stroke:#c084fc,stroke-width:2px,color:#faf5ff

    class A1,A2,A3 s1
    class B1,B2,B3 s2
    class C1,C2,C3,C4,C5 s3
    class D1,D2,D3 s4
    class E1,E2,E3 s5
    class F1,F2,F3 s6
    class DB store
    class U meter
```

<details>
<summary>🔬 &nbsp;<b>Same flow as a request/response sequence</b></summary>

<br/>

```mermaid
sequenceDiagram
    autonumber
    actor You as 👤 You
    participant UI as 🖥️ UI
    participant API as ⚡ FastAPI
    participant GH as 🐙 GitHub
    participant CC as 🤖 claude CLI

    You->>UI: Open a PR
    UI->>API: GET /api/prs/.../diff
    API->>GH: fetch unified diff
    GH-->>UI: diff rendered inline

    You->>UI: ▶️ Run review · pick mode
    UI->>API: POST /api/review
    opt 🔗 linked PRs attached
        API->>GH: fetch linked diffs
    end
    API->>GH: package.json · composer.json · phpstan.neon
    opt 📂 local clone found
        API->>API: git worktree at head ref
    end
    API->>CC: prompt + JSON schema over stdin
    CC-->>API: comments · summary · checklist · usage
    API->>API: 💾 store run in db.json
    API-->>UI: review record

    You->>UI: ✏️ edit · 🗑 dismiss · ✅ select
    You->>UI: 🚀 Push N comments
    UI->>API: POST /api/reviews/:id/push
    API->>GH: createPullRequestReview inline
    GH-->>You: ✅ review live · status → commented
```

</details>

---

## 🏗 &nbsp;Architecture

```mermaid
flowchart TD
    UI["🖥️&nbsp; <b>React + Vite UI</b><br/><i>Assigned PRs · Review</i><br/>:5173"]
    API["⚡&nbsp; <b>FastAPI backend</b><br/><i>server/app · uvicorn</i><br/>:3011"]
    GH["🐙&nbsp; <b>GitHub REST API</b><br/><i>PAT · repo scope</i>"]
    CC["🤖&nbsp; <b>claude CLI</b><br/><i>headless -p · JSON schema</i>"]
    DB["🗃️&nbsp; <b>data/db.json</b><br/><i>prs · reviews · comments</i>"]
    WT["📂&nbsp; <b>git worktree</b><br/><i>LOCAL_REPOS_ROOT</i>"]
    CFG["🎚&nbsp; <b>review_config.json</b><br/><i>model · batching · checklist</i>"]

    UI -->|"proxies /api"| API
    API -->|"search · diff · file · push"| GH
    API -->|"prompt over stdin"| CC
    API <-->|"read / write"| DB
    CFG -.->|"tunes"| API
    CC -.->|"Read · Grep · Glob"| WT

    classDef ui fill:#312e81,stroke:#818cf8,stroke-width:2px,color:#eef2ff
    classDef api fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#ecfdf5
    classDef ext fill:#3f3f46,stroke:#a1a1aa,stroke-width:2px,color:#fafafa
    classDef store fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#fff7ed

    class UI ui
    class API api
    class GH,CC,WT,CFG ext
    class DB store
```

<table>
<tr><th align="left">Path</th><th align="left">Role</th></tr>
<tr><td><code>client/</code></td><td>⚛️ React 19 + Vite 5 + Tailwind v4. Dev server proxies <code>/api</code> to <code>:3011</code>. Shared primitives in <code>client/src/components/ui/</code> — <code>Card</code>, <code>Button</code>, <code>Badge</code>, <code>Input</code>, <code>Textarea</code>.</td></tr>
<tr><td><code>server/app/</code></td><td>🐍 FastAPI: <code>main.py</code>, <code>github.py</code>, <code>claude.py</code>, <code>local_repo.py</code>, <code>db.py</code>, <code>concurrency.py</code>, <code>errors.py</code>, <code>routes/</code>.</td></tr>
<tr><td><code>data/db.json</code></td><td>🗃️ The entire datastore. No external DB in this build — SQLite is the planned upgrade path if it ever needs one, with the API as the seam.</td></tr>
<tr><td><code>server/review_config.json</code></td><td>🎚 Model, concurrency, batching, token caps, frontend/backend repo classification, and the review checklist.</td></tr>
</table>

<details>
<summary>🧱 &nbsp;<b>Notable client modules</b></summary>

<br/>

| Module | Purpose |
|---|---|
| `lib/parseDiff.js` | Parses the raw unified diff into files → hunks → lines, matches comments to lines, builds the file tree, computes hidden hunk gaps, and regroups lines into split-view rows. |
| `lib/parseSummary.js` | Splits Claude's prose write-up into its rendered sections. |
| `lib/prsCache.js` | In-memory cache of the last `GET /api/prs`, so the Review screen can read one PR's metadata without refetching the whole list. |
| `lib/formatUsage.js` | Token totals and `1.2K` / `3.4M` formatting for the usage meter. |
| `lib/useTheme.js` · `useIsDarkMode.js` | Dark / light / system theme, persisted in `localStorage`. |
| `components/DiffView.jsx` | The diff table: view toggle, per-file collapse, gap expansion, inline comment rows. |
| `components/CommentCard.jsx` | An editable comment — severity, text, suggestion box, dismiss/restore, push selection. |
| `components/FileTree.jsx` | Collapsible folder tree of changed files with diffstats, scrolls the diff panel on click. |
| `components/PrReviewWriteup.jsx` · `Markdown.jsx` | The prose review write-up, markdown + GFM + syntax highlighting. |
| `components/PrChecklist.jsx` | The per-run review checklist. |
| `components/Sidebar.jsx` · `ThemeToggle.jsx` | Nav shell, usage meter, theme switch. |

</details>

**Routes:** `/` → Assigned PRs &nbsp;·&nbsp; `/review/:owner/:repo/:number` → the Review screen.

---

## 🎚 &nbsp;Review modes

Chosen per run from the Review screen. All three fall back to **diff-only** if a local clone
isn't available or any git step fails — a review never hard-fails over missing context.

<table>
<tr>
<th align="left" width="18%">Mode</th>
<th align="left" width="12%">Needs a clone</th>
<th align="left" width="14%">Cost / time</th>
<th align="left">How it works</th>
</tr>
<tr>
<td>📄 <b>Diff only</b></td>
<td>No</td>
<td>💰 Lowest</td>
<td>One-shot review of the diff itself, no repository tools. Still gets linked-PR, dependency and PHPStan context.</td>
</tr>
<tr>
<td>🧩 <b>Curated context</b></td>
<td>Yes</td>
<td>💰💰 Middle</td>
<td>Checks the PR out locally, runs one <code>git grep</code> pass per changed file to find likely referencing files, and pastes bounded snippets into a single prompt — more context than diff-only without an interactive tool loop.</td>
</tr>
<tr>
<td>🔬 <b>Deep review</b></td>
<td>Yes</td>
<td>💰💰💰 Highest</td>
<td>Runs inside a disposable <code>git worktree</code> with read-only <code>Read</code> · <code>Grep</code> · <code>Glob</code> tools, so Claude explores the real codebase around the diff.</td>
</tr>
</table>

> [!NOTE]
> **Batch review is diff-only on purpose.** One repo per batch, max **3** concurrent runs —
> each review spawns a real `claude` process, so a multi-PR action stays predictable in cost
> and wall-clock time.

---

## 🚀 &nbsp;Quick start

### 📋 &nbsp;Prerequisites

| | Requirement | Notes |
|:--:|---|---|
| 🟩 | **Node.js** | Client + root tooling. Stay on **Vite 5** unless you check `node -v` first. |
| 🐍 | **Python 3** | With a virtualenv at `server/.venv` providing `uvicorn`. |
| 🤖 | **`claude` CLI** | Already logged in. Used headlessly — **never** via `ANTHROPIC_API_KEY`. |
| 🔑 | **GitHub PAT** | `repo` scope. |
| 📂 | **Local clones** | *Optional* — enables curated and deep review modes. |

<details open>
<summary><b>1️⃣ &nbsp;Install JS dependencies</b></summary>

<br/>

```bash
npm install
```

The root `package.json` uses **npm workspaces** — run commands from the repo root, not from
inside `client/`.

</details>

<details open>
<summary><b>2️⃣ &nbsp;Create the Python environment</b></summary>

<br/>

```bash
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

Installs `fastapi`, `uvicorn[standard]`, `httpx`, `python-dotenv`. The `dev:server` script
expects the venv at exactly `server/.venv`.

</details>

<details open>
<summary><b>3️⃣ &nbsp;Configure your environment</b></summary>

<br/>

```bash
cp server/.env.example server/.env
```

Fill in `GITHUB_TOKEN` — see [Configuration](#️-configuration) for the rest.

> [!IMPORTANT]
> Without `GITHUB_TOKEN`, PR endpoints return a **500 with a clear error** rather than
> failing silently.

</details>

<details open>
<summary><b>4️⃣ &nbsp;Run it</b></summary>

<br/>

```bash
npm run dev
```

<div align="center">

🖥️ &nbsp;**UI** → <code>http://localhost:5173</code> &nbsp;&nbsp;·&nbsp;&nbsp; ⚡ &nbsp;**API** → <code>http://localhost:3011</code>

</div>

</details>

### 🧰 &nbsp;Scripts

| Command | What it does |
|---|---|
| `npm run dev` | ▶️ Backend `:3011` + client `:5173`, concurrently |
| `npm run dev:server` | ⚡ Backend only — `nodemon` watches `server/app` and `review_config.json`, and does a **full process restart** (uvicorn's `--reload` is deliberately avoided, [see why](#-troubleshooting)) |
| `npm run dev:client` | 🖥️ Client only |
| `npm run build` | 📦 Production client build → `client/dist` |
| `npm run lint -w client` | 🧹 `oxlint` over the client |

> [!NOTE]
> **No test suite yet**, and nothing is linted on the server side.

---

## ⚙️ &nbsp;Configuration

### 🔐 &nbsp;`server/.env`

| | Variable | Purpose |
|:--:|---|---|
| 🔑 | `GITHUB_TOKEN` | GitHub PAT (`repo` scope) used for every GitHub API call. **Required.** |
| 🔌 | `PORT` | Backend port. Default **`3011`** — [not 3001, on purpose](#-troubleshooting). |
| 📂 | `LOCAL_REPOS_ROOT` | *Optional.* Folder of local clones, one subfolder per repo name (e.g. `F:\GFS_SaaS\gfs-saas-core`). Enables **curated** and **deep** review; unset means diff-only always. |
| 🛠 | `CLAUDE_CLI_PATH` | *Optional.* Explicit path to the `claude` binary when it doesn't resolve on the server process's `PATH`. |

### 🎚 &nbsp;`server/review_config.json`

<details>
<summary><b>Tuning knobs — click to expand</b></summary>

<br/>

| Key | Meaning |
|---|---|
| `reviewModel` | Which Claude model the headless CLI call uses |
| `reviewConcurrency` | Parallel per-batch review calls within a single review run |
| `batchMaxFiles` · `batchMaxDiffTokens` | How changed files are grouped into one review call |
| `estimateCharsPerToken` · `estimateReserveTokens` | Token-budgeting heuristics for that grouping |
| `linkedContextCharCap` | Cap on the combined linked-PR diff context — truncated, never dropped |
| `frontendRepoNames` · `backendRepoNames` | Repo classification, so prompt addenda and the checklist match the stack |
| `checklist` | Checklist items, each grouped `common` / `frontend` / `backend` |

Edits are picked up on the next backend restart — `nodemon` already watches this file.

</details>

### 🔓 &nbsp;Auth model

<table>
<tr><td width="50%" valign="top">

**🤖 Claude**

Shells out to the **already-logged-in `claude` CLI** in headless mode, prompt piped over
**stdin** with a JSON schema for pre-validated structured output.

`ANTHROPIC_API_KEY` is never used.

</td><td width="50%" valign="top">

**🐙 GitHub**

Calls the **REST API directly** with the `GITHUB_TOKEN` PAT (`repo` scope).

Switching to the `gh` CLI would be a deliberate, documented swap — not a silent one.

</td></tr>
</table>

---

## 🛰 &nbsp;API surface

<details open>
<summary><b>📥 &nbsp;Pull requests</b></summary>

<br/>

| Method | Endpoint | Purpose |
|:--:|---|---|
| `GET` | `/api/prs` | Review-requested + manually added PRs, `status` derived from the db. Bounded-concurrency refresh (limit **8**). |
| `GET` | `/api/prs/:owner/:repo/:number/diff` | Raw unified diff text |
| `GET` | `/api/prs/:owner/:repo/:number/file?path=…` | Raw file content at the PR's head SHA — powers hunk expansion |
| `POST` | `/api/added-prs` | Add a PR by URL |
| `DELETE` | `/api/added-prs/:owner/:repo/:number` | Remove a manually added PR |

</details>

<details open>
<summary><b>🔗 &nbsp;Linked PRs</b></summary>

<br/>

| Method | Endpoint | Purpose |
|:--:|---|---|
| `POST` | `/api/prs/:owner/:repo/:number/links` | Link a related/dependent PR (any repo) by URL |
| `DELETE` | `/api/prs/:owner/:repo/:number/links/:o/:r/:n` | Unlink it |

</details>

<details open>
<summary><b>🤖 &nbsp;Reviews</b></summary>

<br/>

| Method | Endpoint | Purpose |
|:--:|---|---|
| `POST` | `/api/review` | Run a review — body `{ repo, number, mode }`, `mode` ∈ `diff` \| `curated` \| `deep`. Stores a new run. |
| `POST` | `/api/reviews/batch` | Batch-review one repo — body `{ repo, numbers[] }`. Diff-only, max 3 concurrent, returns per-PR `ok` / `error`. |
| `GET` | `/api/reviews` | All runs — filterable by `repo`, `number`, comment `state` |
| `GET` | `/api/reviews/:id` | A single run with its comments, summary and checklist |
| `PATCH` | `/api/reviews/:id/comments/:commentId` | Edit text / severity / suggestion / state (including dismiss) |
| `POST` | `/api/reviews/:id/push` | 🚀 Push selected comments to GitHub, mark them `pushed`, bump PR status |

</details>

<details open>
<summary><b>📊 &nbsp;Usage</b></summary>

<br/>

| Method | Endpoint | Purpose |
|:--:|---|---|
| `GET` | `/api/usage` | Today's totals — input / output / cache-read / cache-creation tokens plus `reviewCount`. Derived from today's runs, so it clears at local midnight instead of needing a reset. |

</details>

---

## 🗃 &nbsp;Data model

<div align="center">

```mermaid
erDiagram
    PR ||--o{ REVIEW : "has runs"
    REVIEW ||--o{ COMMENT : contains
    PR ||--o{ PR : "linkedPrs"

    PR {
        string key "owner/repo-hash-123"
        string metadata "title · url · author · diffstat"
        string source "assigned | manual"
        string status "derived, never stored twice"
        array  linkedPrs "keys of related PRs"
    }
    REVIEW {
        string id "review_xxxx"
        string repo_number "which PR"
        string createdAt "UTC ISO"
        string model "model used"
        bool   withCodebaseContext "curated/deep succeeded"
        string summary "prose write-up"
        array  checklist "per-run answers"
        object usage "token counts"
        array  comments "the findings"
    }
    COMMENT {
        string id "c1, c2, ..."
        string severity "nit | suggestion | issue | blocking"
        string state "suggested | edited | dismissed | pushed"
        string suggestion "exact replacement code, or null"
        string placement "file · line · side"
        string pushedAt "when it went to GitHub"
    }
```

</div>

> [!TIP]
> **Status is derived, not stored twice.**
> `commented` if any run has a `pushed` comment → else `reviewed` if there's ≥1 run →
> else `unreviewed`.

---

## 🩺 &nbsp;Troubleshooting

<details>
<summary>🔌 &nbsp;<b>Why port 3011 instead of 3001?</b></summary>

<br/>

On this dev machine, port `3001` is held by a **ghost listener**: `netstat` reports a
listener that answers real HTTP (stale 404s for every route), but the owning PID matches no
live process. Rather than keep fighting it, the backend and the Vite proxy target both moved
to **3011**. Moving back is safe on any machine without that quirk.

</details>

<details>
<summary>🚫 &nbsp;<b>Code changes don't apply, or a review dies with exit code 3221225794</b></summary>

<br/>

`dev:server` deliberately avoids uvicorn's `--reload`. Its file-watcher thread not only
failed to hot-swap here — it broke `POST /api/review` outright with `0xC0000142`
(`STATUS_DLL_INIT_FAILED`), because the backend can't reliably spawn the Node-based `claude`
binary as a child of that worker. `nodemon` does a **full process restart** instead. Don't
re-add `--reload` without re-verifying this machine's behaviour.

</details>

<details>
<summary>🤖 &nbsp;<b>Claude returns prose instead of JSON</b></summary>

<br/>

Two flags do the real work, not prompt wording: `--tools ""` (stops the model wandering the
filesystem in diff-only mode) and `--json-schema` (returns a pre-validated
`structured_output` field). The prompt **must** go over **stdin** — a long multi-line CLI
argument gets silently requoted and corrupted by `cmd.exe` on Windows.

</details>

<details>
<summary>🧊 &nbsp;<b>Deep review hangs with no output</b></summary>

<br/>

Enabling tools requires `--permission-mode bypassPermissions` — otherwise the CLI waits
forever on a permission prompt that can never arrive over piped stdin. Safe here because
`--tools` stays restricted to **read-only** `Read,Grep,Glob` (never `Bash` / `Edit` /
`Write`). Also: `--bare` is **not** a speed-up — it forces API-key auth and breaks the
logged-in CLI session.

</details>

<details>
<summary>📂 &nbsp;<b>Curated / deep review silently ran diff-only</b></summary>

<br/>

Both modes need the repo under `LOCAL_REPOS_ROOT` as a subfolder named exactly after the
repo. If it isn't there, or any git step fails, the run **falls back to diff-only** and
records `withCodebaseContext: false` rather than erroring.

</details>

<details>
<summary>⏱ &nbsp;<b>The PR list is slow</b></summary>

<br/>

`review-requested:` surfaces ~50–100 open PRs on this org, and refreshing each one's full PR
data sequentially took **38s**. Bounded-concurrency fetching (limit **8**) brought it back to
**~7s**. The JSON store itself is fine at this scale — only the GitHub round-trips needed
fixing.

</details>

<details>
<summary>💥 &nbsp;<b>A push failed and nothing was posted</b></summary>

<br/>

The GitHub review API call is **atomic per review** — if a single comment's `line`/`path`
doesn't resolve against the head commit's diff, the whole push fails rather than partially
posting. If that starts happening in practice, per-comment retry/skip is the fix.

</details>

---

## 🗺 &nbsp;Roadmap

| | Phase | Status |
|:--:|---|:--|
| 1 | Queue — review-requested PRs + add-by-URL, diffstat gutters | ✅ &nbsp;Done |
| 2 | Data layer — `data/db.json`, PR status tracking | ✅ &nbsp;Done |
| 3 | Dashboard | ❌ &nbsp;Removed by request |
| 4 | Review screen — Claude call, structured JSON, editable cards | ✅ &nbsp;Done |
| 5 | Push to GitHub — real inline review + suggestions | ✅ &nbsp;Done |
| 6 | Reviews history screen | ❌ &nbsp;Cut from the plan |
| 7 | Auto-review — scheduling / webhooks / polling | ⬜ &nbsp;Deferred by design |

> [!WARNING]
> **Auto-review is deliberately not built.** If it ever is, it must stop at `suggested` —
> automation never calls the push endpoint unless you opt into a specific policy.

---

<div align="center">

### 📚 &nbsp;Further reading

[![CLAUDE.md](https://img.shields.io/badge/CLAUDE.md-full_internals-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](CLAUDE.md)
&nbsp;
[![PLAN.md](https://img.shields.io/badge/PLAN.md-original_build_plan-6366f1?style=for-the-badge&logo=readme&logoColor=white)](PLAN.md)

<br/>

<sub>Built to run on one machine, for one reviewer — with 🤖 <a href="https://claude.com/claude-code">Claude Code</a></sub>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:ec4899,50:8b5cf6,100:6366f1&height=110&section=footer" alt="" />

</div>
