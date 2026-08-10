# DalOS Land Cloud — Staging

Staging repository for **Farm Structure Cloud**, a module on DalOS separate from Vision and
Analytics. It holds the orchard block register and historical agro-production broken down by
segment (export / local / waste), with structure and history visualised and both single-block
and bulk entry.

> **This repository is public** (GitHub Pages, like the other DalOS repos), so only migrations
> and app code are published. `docs/`, `design/` (the mockup embeds real polygons) and `data/`
> hold real per-farm areas, tonnages, block IDs and geometry — they are gitignored and kept
> locally only. The anon key in the app bundle is public by design; RLS is the boundary. Never
> commit the service-role key or any connection string.

## Status

**The database layer is complete and live.** 31 migrations are applied to Supabase project
`sfyjvgjwvtwkrnqrvqyc` (DalOS-Vision): 18 tables, 9 views, 1 materialised rollup, 11 functions.
What remains is the application, the metric-set seed, and the M2/M3 data load.

## Start here

```bash
./bootstrap.sh
```

That links the project, pulls all 31 migrations into `supabase/migrations/` byte-exactly with
`supabase migration fetch`, runs `db/verify-schema.sql`, and generates types.

**Migrations are not committed to this repo by hand.** They are recorded server-side and
`migration fetch` is the authoritative copy — hand-transcribing them is how files and reality
drift apart. `bootstrap.sh` populates them in one step.

Then read, in order:

| File | What it is |
|---|---|
| `docs/START-HERE.md` | **The build brief.** Setup, the rules that are not negotiable, the invariants, what the database already gives you, and what still needs writing. |
| `docs/BUILD-STATUS.md` | What is applied, what was verified and how, and every defect found by testing. |
| `docs/PRD-farm-structure-cloud.md` | The specification. §6 is the screens. |
| `docs/SCHEMA-FINDINGS.md` | The live-schema check that corrected eight wrong assumptions in the PRD. |
| `design/farm-structure-mockup.html` | Ten screens in the Teal & Sand palette. The Farm Map works against real polygons. Open it in a browser. |

## Schema verification

```bash
psql "$DATABASE_URL" -f db/verify-schema.sql
```

22 assertions, all passing as of 10 Aug 2026. **Run it after every migration and treat a FAIL
as a blocked merge.** Seven assertions read the *installed source* of the views and functions
rather than the table layout, so they catch a well-meaning change that quietly reverses a
decision — a unique constraint added to `financial_block_id`, a `farm_historical_map` insert
added to the replant path, a `DISTINCT ON` dropped from the inherited-rates view. Those
failures do not announce themselves: they produce plausible, wrong numbers.

Wire it into CI against a preview branch before anything reaches production.

## Changing the schema

Claude Code owns the schema from handover. Through files, always:

```bash
supabase migration new <snake_case_name>
#   write the SQL, include a tested `-- down` section, commit, get it reviewed
supabase db push
psql "$DATABASE_URL" -f db/verify-schema.sql
```

The three ways to change this schema are not equivalent:

| Method | Recorded in `schema_migrations` | File in the repo |
|---|---|---|
| Supabase SQL editor / `execute_sql` | **No — invisible** | No |
| MCP `apply_migration` | Yes | No |
| `migration new` + `db push` | Yes | **Yes** |

The SQL editor is the one to avoid outright: the change is real but unrecorded, so
`migration fetch` cannot recover it and `migration list` reports no drift. A preview branch
built later silently lacks it.

**Never run `supabase db reset` against `sfyjvgjwvtwkrnqrvqyc`.** It rebuilds from migrations,
and 185 of the 216 predate this module.

Reading is unrestricted — use `execute_sql` freely for investigation.

## Three things that look like bugs and are not

The full list is in `docs/START-HERE.md`. These three cause the most trouble:

- **`financial_block_id` has no unique index.** Six real blocks collide on it, one block
  carrying several rootstocks. Constraining it fails the data load. `operational_block_id`,
  which appends the rootstock code, is the only genuine natural key.
- **Four columns on `farm_blocks` are generated** — `block_code`, `aydi_block_number`,
  `financial_block_id`, `operational_block_id`. They appear in the generated types; Postgres
  rejects any write that includes them.
- **Own-rooted is a rootstock row named `No`, not a NULL.** The workbook appends `NO` to the
  identity, so a NULL breaks the match to the workbook and to JDE on 22 blocks.

## Open

- **Basemap key.** Cost is not the issue — Esri's free tier is 2M tile requests/month. But the
  mockup uses keyless endpoints not covered by any agreement, and a production key must be
  domain-restricted or proxied because the main DalOS repo is public.
- **`audit_log` revision.** Fails 3 of the 5 checks in §11d of the PRD. A platform change
  needing its own review, not a `farm_*` migration. Must land before geometry arrives in P6.
