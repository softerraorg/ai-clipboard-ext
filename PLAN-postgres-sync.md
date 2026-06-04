# Postgres Sync for Proposal Chatbot — Implementation Record

**Started:** 2026-06-02
**Completed:** 2026-06-04
**Status:** Phases 1–4 done. Phase 5 (housekeeping) pending.

---

## Outcome

The proposal chatbot now reads from a local PostgreSQL database instead of calling ClickUp and Google Sheets APIs on every request. Two n8n workflows sync the source data into Postgres every 48 hours.

---

## Key References

| Item | Value |
|------|-------|
| n8n instance | `https://n8n.srv1438819.hstgr.cloud` |
| Original chatbot workflow (v1) | `https://n8n.srv1438819.hstgr.cloud/workflow/NtDFa2OKe3sSn8sS` |
| New chatbot workflow (v2, Postgres-backed) | `Proposal Chatbot (Postgres) - v2` |
| **v2 webhook URL (set in extension)** | `https://n8n.srv1438819.hstgr.cloud/webhook/a62a843b-7f47-4b85-8b62-eb5d6d7f6e39/chat` |
| v1 webhook URL (kept for fallback) | `https://n8n.srv1438819.hstgr.cloud/webhook/9143067a-e4f1-4401-88bc-7c9af0e2b5ec/chat` |
| Postgres container | `postgresql-wqds-postgresql-1` (PostgreSQL 17) |
| Postgres internal hostname | `postgresql` (alias on `postgresql-wqds_default` network) |
| Database | `chatbot_db` |
| ClickUp workspace ID | `90181046044` (Softerra) |
| ClickUp Clients space ID | `90183782013` |

Credentials live in [.env](.env) (gitignored). Backup in Vaultwarden pending.

---

## Phase 1 — PostgreSQL on VPS

**Deviation from original plan:** A PostgreSQL 17 container was already running on the VPS (`postgresql-wqds-postgresql-1`). Instead of deploying a new one, we reused it and created a dedicated `chatbot_db` database inside.

**Networking fix:** Postgres lived on `postgresql-wqds_default` network; n8n was on `n8n_default`. They could not talk. Resolved by connecting n8n to the Postgres network:

```bash
docker network connect postgresql-wqds_default n8n-n8n-1
```

**Database created:**

```bash
docker exec -it postgresql-wqds-postgresql-1 psql -U YyHXiTdoEcc42BuE -d p7N7YhawZRLpdhSv \
  -c "CREATE DATABASE chatbot_db;"
```

**Schema (lives in `chatbot_db`):**

```sql
CREATE TABLE clickup_tasks (
    task_id        TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    status         TEXT,
    assignee       TEXT,
    due_date       TIMESTAMPTZ,
    list_name      TEXT,
    space_name     TEXT,
    custom_fields  JSONB,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE portfolio (
    row_number        INTEGER PRIMARY KEY,
    client_name       TEXT,
    niche             TEXT,
    url               TEXT,
    platform          TEXT,
    theme             TEXT,
    what_we_built     TEXT,
    case_study_url    TEXT,
    figma             TEXT,
    github            TEXT,
    upwork_case_study TEXT,
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE profile (
    row_number  INTEGER PRIMARY KEY,
    field       TEXT,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Deviation:** Originally planned a generic `sheets_data (JSONB)` table. Switched to dedicated typed `portfolio` and `profile` tables once the actual Google Sheets columns were known — easier to query from the chatbot prompt builder.

**n8n credential:** Saved as `Postgres account` (Host: `postgresql`, Port: `5432`, DB: `chatbot_db`, SSL: disable).

---

## Phase 2 — ClickUp → Postgres sync workflow

Workflow name: `ClickUp → PostgreSQL Sync`. Active, runs every 2 days.

**Final node chain:**

```
Schedule Trigger (every 2 days)
   → Get All Tasks (HTTP GET team task endpoint, filtered to Clients space)
   → Split Tasks (split out the tasks array)
   → Map Fields (Code node — UTC→PKT conversion, wrap custom_fields)
   → Upsert to Postgres (Insert or Update, match on task_id)
```

**Deviation from original plan:** The plan called for looping over folders → lists → tasks. In practice, the `/team/{teamId}/task` endpoint with `space_ids[]` filter pulls all tasks from the Clients space in one call. Much simpler.

**ClickUp endpoint used:**

```
GET https://api.clickup.com/api/v2/team/90181046044/task
    ?space_ids[]=90183782013&include_closed=true&subtasks=true&page=0
```

**Field mapping (`Map Fields` Code node):**

```javascript
const PKT_OFFSET = 5 * 60 * 60 * 1000;

return $input.all().map(({ json: t }) => ({
  json: {
    task_id:       t.id,
    name:          t.name,
    status:        t.status?.status ?? null,
    assignee:      t.assignees?.[0]?.username ?? null,
    due_date:      t.due_date
                     ? new Date(Number(t.due_date) + PKT_OFFSET).toISOString()
                     : null,
    list_name:     t.list?.name ?? null,
    space_name:    t.space?.name ?? null,
    custom_fields: { fields: t.custom_fields ?? [] },
    updated_at:    new Date().toISOString()
  }
}));
```

**Gotcha — JSONB columns:** n8n's Postgres "Insert or Update" operation requires JSONB values to be objects, not arrays. We wrap the ClickUp `custom_fields` array as `{ fields: [...] }`. Query accordingly: `custom_fields->'fields'`.

**Postgres operation:** `Insert or Update` (n8n's name for upsert), conflict column `task_id`. The original plan used raw SQL with parameter bindings, but n8n's comma-split of `Query Parameters` corrupts JSON values containing commas — the built-in operation handles this correctly.

**Pagination note:** Currently only fetches page 0 (~100 tasks). If the workspace grows past 100 active tasks, add a pagination loop. Verified 100 tasks synced on first run.

---

## Phase 3 — Google Sheets → Postgres sync workflow

Workflow name: `Google Sheets → PostgreSQL Sync`. Active, runs every 2 days.

**Source:** Document `Portfolio Links (Hassan)`, two tabs: `Portfolio` and `Profile`.

**Final structure** (two parallel branches from the Schedule Trigger):

```
Schedule Trigger
  ├─ Read Portfolio (Google Sheets) → Map Portfolio → Upsert Portfolio
  └─ Read Profile   (Google Sheets) → Map Profile   → Upsert Profile
```

**Match column:** `row_number` (Google Sheets row index) for both tables.

**First sync counts:** Portfolio = 117 rows, Profile = 26 rows.

---

## Phase 4 — Update chatbot to use Postgres

**Approach:** Duplicated the live workflow (`NtDFa2OKe3sSn8sS`) into `Proposal Chatbot (Postgres) - v2` so v1 stays running during testing. Replaced three nodes in v2:

| Old node (v1)                  | New node (v2)                                                                |
|--------------------------------|------------------------------------------------------------------------------|
| `Read Portfolio` (Google Sheets) | Postgres `SELECT … FROM portfolio` (Execute Once)                            |
| `Read Profile` (Google Sheets)   | Postgres `SELECT field, value FROM profile` (Execute Once)                   |
| `Get ClickUp Tasks` (ClickUp API) | Postgres query against `clickup_tasks` filtered to active statuses (Execute Once) |

**Gotcha — Execute Once toggle:** Without `Execute Once`, n8n runs the SELECT query once per input item, so chained Postgres reads multiply (117 portfolio rows × 26 profile rows = 3042 returned). Toggle on for every Postgres read node in chains.

**ClickUp query for chatbot:**

```sql
SELECT task_id, name, status, assignee, due_date, list_name, space_name
FROM clickup_tasks
WHERE status NOT IN ('done', 'closed', 'cancelled')
ORDER BY due_date ASC NULLS LAST;
```

**Extension change required:** Update `n8nWebhookUrl` in extension Settings to the v2 URL (already done).

**End-to-end test results:**
- Proposal generation: ~16 seconds end-to-end (down from prior ~30–60s).
- ClickUp query (`"What's the status of Kelly's project?"`): returned 4 in-progress Kelley tasks correctly from Postgres.

---

## Phase 5 — Housekeeping (TODO)

| Item | Status |
|------|--------|
| Save Postgres + n8n + ClickUp credentials in Vaultwarden under `chatbot/*` | Pending |
| Decide backup schedule (nightly `pg_dump` to a dated file on host volume recommended) | Pending |
| After v2 is stable for a week, archive v1 workflow `NtDFa2OKe3sSn8sS` | Pending |
| If task count exceeds 100, add pagination loop to `Get All Tasks` | Pending (monitor) |
| Replace ClickUp API token (currently belongs to Hamayun Aziz) with Hassan's own token if broader visibility is needed | Optional |
| Rotate the Anthropic API key that was exposed during setup | Pending |

---

## Files in this repo

- [.env](.env) — local credentials (gitignored). Contains Postgres, n8n, ClickUp, and Anthropic creds.
- [PLAN-postgres-sync.md](PLAN-postgres-sync.md) — this file.
