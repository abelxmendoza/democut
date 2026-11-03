# DemoCut Cloud Storage — Design Plan

**Status: PLANNED 2026-11-02 (Abel's call: plan tonight, build after the Meta
hackathon). Nothing in this document is built yet.** It exists so the build,
when it starts, is execution against decisions — not a fresh design session.

## The problem

Today everything is local: projects/settings in `localStorage`, take files in
IndexedDB. That means: one browser, one machine, no backup if the browser
evicts storage, no sharing. Abel already feels this himself (Ryuk ↔ scythe);
any real user will too.

## Principles

1. **Local-first stays the foundation.** Recording, editing, captions and
   auto-edit keep working fully offline with no account. Cloud is opt-in per
   user; video upload is opt-in per take.
2. **The privacy promise narrows honestly, in writing, in the same release
   that changes it.** Today's footer ("recordings never leave your machine")
   becomes "recordings never leave your machine unless you save them to your
   cloud" when Phase 2 ships — not before, not silently.
3. **Bytes never pass through our server.** The browser uploads/downloads
   directly to object storage using short-lived signed URLs. The API only
   checks identity and signs.
4. **No video in a database, ever.** The database holds metadata only.

## Recommended stack

| Piece | Choice | Why |
|---|---|---|
| Auth + metadata DB | **Supabase** (Auth + Postgres + Row-Level Security) | One service for login + DB; metadata is kilobytes, so the free tier lasts; magic-link + OAuth built in |
| Video files | **Cloudflare R2** | **$0 egress** — the deciding factor for video. Storage $0.015/GB-mo after 10 GB free. S3-style egress (~$0.09/GB) makes playback the dominant cost; Supabase Storage's free tier (1 GB) holds only a few demos |
| API layer | **Vercel serverless functions** in the existing deployment (`/api/*`) | Verifies the Supabase JWT, mints R2 presigned URLs scoped to `users/<userId>/takes/<takeId>`. R2 credentials live only in Vercel env vars |

Alternative considered: all-in on Cloudflare (Worker + D1 + R2 + hand-rolled
auth). Rejected for v1 — auth is the fiddly part and Supabase hands it to us;
R2 is still used where it is uniquely strong.

## Data model (Postgres; mirrors the local shapes)

- `profiles` — `id` (= auth user id), `email`, `created_at`
- `projects` — `id`, `user_id`, `name`, `title`, `open_first`, `script`,
  `target_sec`, `builtin_source` (nullable), `updated_at`, `deleted_at`
- `takes` — `id`, `user_id`, `project_id`, `name`, `duration`, `size`,
  `created_at`, `markers` (jsonb), `captions` (jsonb), `storage_key`
  (nullable — null means local-only), `storage_state`
  (`local | uploading | stored | failed`), `updated_at`, `deleted_at`
- `shares` — `id`, `take_id`, `user_id`, `token` (unique), `created_at`,
  `revoked_at` (Phase 3)

RLS on every table: a user can only read/write rows where `user_id` = their
auth id.

## Sync rules

- The local copy remains the working copy. Sync is background and
  asynchronous; it never blocks recording or editing.
- Last-write-wins per record by `updated_at`; deletes propagate via
  `deleted_at` tombstones. (The real case is one user on several machines;
  simultaneous multi-editor conflicts are out of scope.)
- On first sign-in: pull → merge → push up local-only records (imports the
  user's existing projects automatically).
- Take **metadata** syncs early (it's tiny — and it carries chapters +
  captions with it). Take **files** upload only when the user taps
  "Save to cloud" on that take. Auto-uploading every take is explicitly
  *not* the default: sizes and privacy both say no.
- A stored take can stream into the library player without downloading;
  "Download to this device" pulls the blob into IndexedDB for editing.

## Flows

- **Upload:** client → `POST /api/sign-upload {takeId, size, type}` → API
  checks JWT + ownership + quota → presigned PUT (15-min expiry, exact key)
  → client PUTs straight to R2 with a progress bar → client sets
  `storage_state = 'stored'`.
- **Playback (stored, not local):** `/api/sign-download` → presigned GET
  (1 h) → `<video src>`.
- **Share (Phase 3):** public page `/v/<token>` asks `/api/share/<token>`
  for a fresh presigned GET. Revoking sets `revoked_at` and the link dies
  immediately — the token never maps to a permanent public URL.

## Quotas & cost guardrails

- Per-user free quota: **2 GB** stored (≈10 demos), enforced at sign-upload
  by summing the user's `takes.size`.
- Cost check at 100 active users × 10 stored demos × ~180 MB ≈ 180 GB:
  R2 ≈ **$2.55/mo** beyond the free 10 GB, egress $0. Supabase free tier
  covers auth + metadata DB at this scale. Vercel functions negligible.
- Uploads require auth; signed URLs are single-key and short-lived; quota
  is checked *before* signing.

## Privacy & safety

- The R2 bucket is **private** — no public URLs exist. Every read goes
  through a signed URL or the share route.
- Object keys are derived from the JWT's user id by the API, never from
  client input.
- Deleting a take deletes its R2 object. Bucket lifecycle rule: abort
  orphaned multipart uploads after 1 day.

## Build order (post-hackathon)

1. Supabase project + schema + RLS; auth UI (magic link first). **Phase 1**
2. Project sync + first-run import. **Phase 1**
3. Take-metadata sync (no files yet). **Phase 1.5**
4. R2 bucket + `/api/sign-upload` + per-take "Save to cloud" with progress
   and `storage_state` shown in the library. **Phase 2**
5. Stream/restore + download-to-device. **Phase 2**
6. Shares + public `/v/<token>` page. **Phase 3**
7. Footer/README privacy-copy update — same release as Phase 2.

## Open questions for Abel (decide at build time)

- Launch sign-in: magic link only (simplest) or add Google/GitHub at once?
- Free quota: 2 GB — confirm or adjust.
- Electron build uses the same cloud (same web core), with save-to-folder
  staying primary there — confirm.
