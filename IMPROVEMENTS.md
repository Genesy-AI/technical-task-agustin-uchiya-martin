# Technical analysis from notes I took while learning the codebase

- Monorepo to reduce duplication and share backend and frontend types and utilities.
- ESLint (currently added the dep but not in use), Prettier to OXC tooling.
- TS5 to TS7 (TSGO)
- CI/CD Checks
- Git hooks to not overload pipelines with format or linter.
- Telemetry OTEL
- Testing
- Responsive fixes
- Security
- Architecture tests
- Maybe move to a modular monolith approach to enable feature decoupling
- E2E testing
- Dependabot, group deps updates by project instead of one by one.
- Check web performance (Lighthouse)
- Accessibility
- PR Review and approval required to merge
- Visual regression test and review, storybook and chromatic
- the tailwind.config.js is it actually needed for tailwind v4?
- Prisma is in v6, might worth to make the upgrade to v8.
- Zod usage for schemas validation

---

# TinyEnginy — Codebase Analysis & Technical Roadmap CLAUDE GENERATED

| | |
|---|---|
| **Type** | Epic / Technical roadmap |
| **Status** | Proposal, open for discussion |
| **Scope** | `backend/` (Express + Prisma + Temporal), `frontend/` (React + React Query + Vite) |
| **Snapshot** | Branch `hotfix/email-verification-stalls` @ `13b90af` |

---

## 1. Executive summary

TinyEnginy works for the happy path: import a CSV, list leads, generate templated messages, verify emails. The foundations are reasonable: a typed API client, React Query, Temporal for async work, and unit tests on the core utilities (68 tests, all passing).

It is not production-ready yet. The main gaps, in order of how much they hurt:

1. **Broken contracts and a broken build.** Two of the CRUD endpoints can't be called correctly from the frontend, `pnpm build` fails on a type error, and `pnpm lint` doesn't run.
2. **No safety net.** There's no CI, no input validation layer, no auth, and no tests for the HTTP layer or the UI.
3. **The architecture won't scale with the product.** All routes live in one `index.ts`, every lead field is hard-coded in about 6 places, long-running enrichments run inside a blocking HTTP request, and the Temporal worker shares a process with the API.
4. **Product gaps.** Users can't search, filter, edit, or paginate leads. Enrichment results can't express "in progress" or "failed", and there's a placeholder feature ("Guess Gender") that users can click.

The roadmap in §4 orders this work: first stabilize, then add guardrails, then restructure for growth, then build product features.

---

## 2. Current state at a glance

| Area | Status | Notes |
|---|---|---|
| Backend type-check (`tsc`) | ✅ Passes | |
| Backend tests | ✅ 42 passing | Utilities and workflow only, no route tests |
| Frontend type-check / `pnpm build` | ❌ **Fails** | `useApiMutation.ts:64`: missing `emailVerified` in the optimistic lead |
| Frontend lint | ❌ **Doesn't run** | ESLint 9 installed, but the config is the legacy `.eslintrc.cjs` format |
| Frontend tests | ✅ 26 passing | Utilities only, no component tests |
| CI | ❌ None | No `.github/workflows` |
| Dependency hygiene | ⚠️ | 3 open Dependabot PRs (vite, follow-redirects, source-map-js) |

---

## 3. Findings

Each finding has a **priority** (P0 = fix now, P1 = next sprint, P2 = planned, P3 = nice to have) and a rough **effort** (S < ½ day, M ≈ 1–2 days, L ≈ 1 week+).

### 3.1 Correctness & API contract

| # | Finding | Impact | Proposal | Pri | Effort |
|---|---|---|---|---|---|
| C1 | `POST /leads` reads `req.body.name`, but the frontend `LeadsCreateInput` sends `firstName`. | Creating a single lead always returns 400. | Align on `firstName`. Add a contract test. | P0 | S |
| C2 | The frontend calls `PUT /leads/:id`, but the backend only exposes `PATCH`. `PATCH` also does `String(name)`, so any field that's omitted gets stored as the literal string `"undefined"`. | Updates fail, and partial updates would corrupt data. | Use PATCH everywhere and only write the fields that were provided (validated with a schema). | P0 | S |
| C3 | `pnpm build` fails (see §2). Frontend types have drifted from the DB: `lastName`/`email` are typed nullable but are `NOT NULL` in the schema, and `LeadsCreateOutput` is incomplete. | No deployable build. Types give a false sense of safety. | Fix the build now. Long term, generate shared types from one source (see A3). | P0 | S |
| C4 | `GET /leads/:id` returns `200 null` for missing leads. `DELETE /leads/:id` on a missing id throws Prisma `P2025`, which becomes a 500. Non-numeric ids become `NaN`, which also becomes a 500. | Clients can't tell "not found" from "server broken". | Central error handler that maps Prisma errors to 404/409. Validate route params. | P1 | S |
| C5 | Bulk import dedupes by **first + last name** instead of email. The DB lookup is case-sensitive while the in-memory key is lowercased, and duplicates *within* the same payload aren't removed server-side. There's no unique constraint either. | Different people who share a name get silently dropped, and real duplicates can still get in. | Make email the identity (`@@unique([email])`, normalized to lowercase), use `createMany` + `skipDuplicates` or an upsert, and report skipped rows back to the user. | P1 | M |
| C6 | Bulk import and message generation issue **one query per lead, sequentially**, with no transaction. | Slow on large CSVs, and a failure partway through leaves partial state. | Batch writes (`createMany`, or `$transaction` with chunks). | P1 | S |
| C7 | The CSV import bug (garbled country codes) and the email-verification stall are known bugs tracked separately. The stall is being fixed on this branch. | | See the remaining verification follow-ups in A4. | — | — |

### 3.2 Architecture & maintainability

| # | Finding | Impact | Proposal | Pri | Effort |
|---|---|---|---|---|---|
| A1 | `backend/src/index.ts` (~330 lines) mixes CORS, routing, validation, business logic, the Temporal client, and server bootstrap. | Hard to test and review, and every feature touches the same file. | Split into `routes/` → `services/` → `repositories/`, with `config.ts` and `app.ts` separate from `server.ts` so routes can be tested with supertest. `verifyEmails.ts` already follows this pattern with injected deps, so extend it. | P1 | M |
| A2 | **Lead fields are hard-coded in about 6 places:** the Prisma schema, the bulk-import mapping, `messageGenerator.availableFields`, `csvParser`'s `switch`, `MessageTemplateModal.availableFields`, and the `LeadsList` columns plus frontend types. | Every new field (phone, LinkedIn, years at company…) means editing all of them, and they drift (they already have). This blocks the "field list will keep growing" requirement. | Add a **lead field registry**: one definition per field (`key`, `label`, `type`, `csvAliases`, `templatable`, `validator`), shared by the backend and frontend. Columns, CSV mapping, template variables, and validation are all derived from it. | P1 | M |
| A3 | No shared schema between client and server. Request validation is ad-hoc `if (!x)` checks. | Contract bugs like C1/C2 ship unnoticed. | Introduce **zod** schemas in a shared package (pnpm workspace). Use them for request validation on the backend and for type inference on the frontend. tRPC or an OpenAPI-generated client are also options. | P1 | M |
| A4 | **Enrichment runs inside a synchronous HTTP request.** `POST /leads/verify-emails` blocks until every workflow finishes (up to 15s) and fans out unbounded `Promise.allSettled` over all selected leads. `emailVerified: boolean \| null` can't represent *pending* or *failed*. | Timeouts on large selections, no progress feedback, the result is lost if the tab closes, and this pattern can't be reused for the upcoming phone enrichment (3 providers, retries, and soon rate limits). | Make enrichments **asynchronous**: the endpoint starts workflows (idempotent ID per lead + enrichment type) and returns `202`. The workflow writes results to the DB. Add a status per enrichment (`PENDING / SUCCESS / NOT_FOUND / FAILED` + `updatedAt` + `error`). The frontend polls or uses SSE. Use one generic "enrichment" abstraction for email, phone, gender, and so on. | P1 | L |
| A5 | The Temporal **worker runs in the API process**, and if the worker fails the process calls `process.exit(1)`. | Temporal being down takes the whole API down. You can't scale workers and API independently. | Separate `worker` entrypoint/process. The API degrades gracefully (returns 503 for enrichment endpoints) when Temporal is unavailable. | P1 | S |
| A6 | Configuration is hard-coded: the DB url (`file:./dev.db`), Temporal address, task queue (`myQueue`), port 4000. `.env.sample` describes a MySQL URL that's never used. | Can't deploy to different environments, and the sample is misleading. | `config.ts` validated with zod from env. Use `env("DATABASE_URL")` in Prisma. Fix `.env.sample`. Use a meaningful task queue name. | P1 | S |
| A7 | `backend/prisma/dev.db` is committed to git and shows as modified on every run. | Noisy diffs, merge conflicts, and possibly real data in the repo. | Untrack it, add it to `.gitignore`, and provide a `prisma db seed` script with fixtures instead. | P1 | S |
| A8 | Frontend dead or inconsistent abstractions: `useApiMutation` (ts-toolbelt + lodash `get` type gymnastics) and `MAX_UPLOAD_FILE_SIZE` are never used. Components call `useMutation` directly with string query keys. | Confusing for new contributors, and the dependencies are dead weight. | Pick one pattern: either delete `useApiMutation` or adopt a simpler query-key factory (`leadsKeys.all`, …) plus per-feature hooks (`useVerifyEmails`, `useImportLeads`). Remove `ts-toolbelt` and `lodash` if they end up unused. | P2 | S |
| A9 | `LeadsList.tsx` (453 lines) and the modals have large inline SVGs, even though `@tabler/icons-react` is already a dependency. Button styles are repeated by copy-paste. | Hard to read and change. | Extract `Button`, `Dropdown`, `Modal`, and `LeadsTable` components and use Tabler icons. Consider a headless UI library (Radix / Headless UI) for accessible dropdowns and modals. | P2 | M |
| A10 | SQLite with no indexes. | Fine for a demo, but it can't handle concurrent writers in production. | Move to Postgres for staging/prod. Add indexes on `email` and `createdAt`. | P2 | M |

### 3.3 Security

| # | Finding | Proposal | Pri | Effort |
|---|---|---|---|---|
| S1 | No authentication or authorization. Anyone who can reach the API can read or delete all leads. | Add auth (session/JWT via a provider). Scope leads to a workspace/tenant. | P1 | L |
| S2 | CORS is `*`, implemented by hand. | Use the `cors` middleware with an env-configured allowlist. | P1 | S |
| S3 | No request size limits, rate limiting, or upper bound on `ids`/`leadIds`/`leads` array length. | Set `express.json({ limit })`, cap array sizes in the schemas, add `express-rate-limit`. | P1 | S |
| S4 | Upcoming provider API keys (phone enrichment) must not be hard-coded. | Load them from env or a secret manager and never log them. | P1 | S |
| S5 | CSV import has no file-size limit (the existing constant is unused), and parsing happens on the main thread. | Enforce a size limit. Use Papa's `worker: true` for large files. | P2 | S |

### 3.4 Observability & operations

| # | Finding | Proposal | Pri | Effort |
|---|---|---|---|---|
| O1 | Logging is just `console.error`, with no request IDs or structure. | Use `pino` + `pino-http` with request IDs, and propagate the ID into Temporal workflow memo/search attributes. | P1 | S |
| O2 | No health/readiness endpoints and no graceful shutdown. | Add `GET /healthz` and `/readyz` (DB + Temporal), and handle `SIGTERM` by draining the server, the worker, and Prisma. | P1 | S |
| O3 | No error tracking or metrics. | Sentry (FE + BE). Track enrichment success/failure/latency metrics per provider; this is critical once paid providers are involved. | P2 | M |
| O4 | No Dockerfile or compose setup. Getting started takes about 8 manual steps (README). | Add `docker-compose` with API, worker, Temporal, and DB, plus root `pnpm` workspace scripts (`pnpm dev` starts everything). | P2 | M |

### 3.5 Testing & quality

| # | Finding | Proposal | Pri | Effort |
|---|---|---|---|---|
| T1 | No CI. | GitHub Actions: install → type-check → lint → test for both packages on every PR, plus a required status check on `main`. | P0 | S |
| T2 | Lint doesn't run (ESLint 9 with a legacy config). The backend has no linter. | Migrate to `eslint.config.js` (flat config) and share it across packages. | P0 | S |
| T3 | No HTTP-level tests. C1/C2 would have been caught by them. | Route tests with supertest against a temp SQLite DB. | P1 | M |
| T4 | No component tests, even though RTL + jsdom are already configured. | Cover `CsvImportModal`, `MessageTemplateModal`, and the selection/bulk actions in `LeadsList`. | P2 | M |
| T5 | Workflow tests mock `proxyActivities` instead of running the workflow. | Use `@temporalio/testing` (`TestWorkflowEnvironment` with time skipping) to test timeouts and retries for real. This matters a lot for the provider waterfall. | P2 | S |
| T6 | No E2E. | One Playwright happy path: import CSV → verify → generate messages. | P3 | M |

### 3.6 UX & product

| # | Finding | Proposal | Pri | Effort |
|---|---|---|---|---|
| U1 | "Guess Gender" shows in the menu but only raises an error toast. | Hide it behind a feature flag until it ships. | P1 | S |
| U2 | `GET /leads` returns every row, and the table renders every row. | Server-side pagination (cursor), plus search, sort, and filter (by country, company, verification status). Virtualize the table. | P1 | M |
| U3 | No way to create or edit a single lead from the UI. The empty state says "add your first lead" but there's no button for it. | Add a create/edit drawer. The empty state should offer "Import CSV" and "Add lead". | P2 | M |
| U4 | Enrichment status is shown as emoji (❓✅❌). It's ambiguous ("❓" means both "never checked" and "check failed"), not accessible, and has no tooltip explaining why. | Status badges with tooltips (reason, last checked at). Render pending state live (ties into A4). | P2 | S |
| U5 | Delete has no confirmation and no undo. | Confirmation dialog or an undo toast (soft delete with `deletedAt`). | P2 | S |
| U6 | The dropdown doesn't close on outside click or Escape, the modals don't trap focus, and the checkboxes have no labels. | Use accessible primitives (see A9). Do a quick axe audit. | P2 | S |
| U7 | The error state's "Refresh Page" button calls `window.location.reload()`. | Call `leads.refetch()` instead. | P3 | S |
| U8 | Message generation is pure string templating, and leads with a missing field fail outright. | Support fallbacks (`{firstName\|there}`), a live preview against a sample lead, and, as a product bet, **AI-personalized messages** (Claude) using the enriched data, with the template as a guide. | P3 | L |
| U9 | Messages are generated and stored, but there's nothing after that (no export or send). | CSV export of leads + messages as the first step toward sequences/outreach integrations. | P3 | M |

---

## 4. Roadmap

### Phase 0 — Stabilize (≈ 1–2 days) 🔴
Goal: `main` is green and every existing feature actually works.
- Fix C1, C2, C3, and C4.
- T1 CI pipeline + T2 lint migration.
- A7 untrack `dev.db` + seed script. A6 env-based config.
- Merge or close the open Dependabot PRs.
- U1 hide unfinished features.

### Phase 1 — Guardrails (≈ 1 sprint) 🟠
Goal: contract bugs can no longer reach production unnoticed, and the app is safe to expose.
- A3 shared zod schemas + request validation. S2/S3 hardening.
- A1 split the backend into layers. T3 route tests.
- O1 structured logging, O2 health checks + graceful shutdown.
- A5 separate worker process.
- C5/C6 correct, batched, email-based dedupe with a unique constraint.

### Phase 2 — Scale the enrichment platform (≈ 1–2 sprints) 🟡
Goal: adding a new field or a new enrichment is a small, low-risk change.
- **A2 lead field registry.** This unblocks the new-fields feature and the scalable message-composer UX.
- **A4 async enrichment framework:** status model, idempotent workflow IDs, polling/SSE, and a provider abstraction with per-provider rate limiting (Temporal activity task-queue rate limits or a token bucket). Phone enrichment and gender guessing plug into it.
- T5 real Temporal tests. O3 per-provider metrics and cost tracking.
- U2 pagination, search, and filters. U4 status badges.

### Phase 3 — Production & product growth (ongoing) 🟢
- S1 auth + multi-tenancy. A10 Postgres.
- O4 Docker/compose and deployment pipeline (staging → prod).
- A8/A9 frontend component library cleanup. T4/T6 component and E2E tests.
- U3, U5, U6 lead editing, safe delete, accessibility.
- U8/U9 AI-personalized messaging and export/outreach integrations.

---

## 5. Open questions for the team

1. **Lead identity:** is email the unique key for a lead, or can a person have multiple emails? This decides the dedupe strategy (C5).
2. **Enrichment cost:** do providers bill per call? If so, should we cache results and add a re-enrich cooldown, and do users need to see the cost before running?
3. **Multi-tenancy timeline:** if workspaces are coming soon, scoping should land before the schema grows further.
4. **Field registry scope:** should users be able to define *custom* fields (stored as JSON or EAV), or only fields the product team ships? This changes the A2 design significantly.
