# Onboarding a new club: PlayHQ fixture sync

Everything club-specific lives in **config**, not code. Onboarding a club means
filling in values — no edits to `playhq-sync-worker.js` or the import screen.

Each club gets its **own** Worker deployment and its own Supabase project. The
Worker holds that club's PlayHQ API key server-side; the app never sees it.

---

## 1. Collect the club's PlayHQ details

| Value | Where it comes from |
|---|---|
| **API key** | Club submits a support request at `support.playhq.com`. PlayHQ issues a key (a UUID, sometimes called Client ID). |
| **Tenant code** | The sport's short code: `ca` = Cricket Australia, `bv` = Basketball Victoria, etc. |
| **Organisation UUID** | The club's full PlayHQ org ID. Public URLs only show the first 8 characters — see below for how to get the full UUID. |

### Getting the full Organisation UUID

The club's public PlayHQ URL contains only the 8-char prefix, e.g.
`playhq.com/cricket-australia/org/bundoora-united-cricket-club/a1b2c3d4`.

To get the full UUID, open that page in a browser and search the page source for
that prefix followed by a UUID pattern — PlayHQ embeds the full ID in the page
data. (For Laurimar, `b86d295c` → `b86d295c-0159-40ad-90af-727e7f898822`.)

If you genuinely cannot obtain it, the Worker will fall back to matching teams
by club **name** via `PLAYHQ_CLUB_NAME` — but the UUID is strongly preferred as
it is exact and immune to naming differences.

---

## 2. Create the club's Worker

```bash
cp wrangler-playhq-sync.toml wrangler-playhq-sync-bucc.toml
```

Edit the copy:

- `name` → a unique Worker name, e.g. `playhq-sync-bucc`
- `[vars] PLAYHQ_CLUB_NAME` → the club name **as it appears on PlayHQ**, which
  may differ from the app's branding (e.g. `"Bundoora United"`, not `"BUCC"`).
  Only used as a fallback when `PLAYHQ_ORG_ID` is unset.
- `[vars] APP_URL` → that club's deployed app URL
- `[vars] ONESIGNAL_PROXY_URL` → that club's OneSignal proxy Worker

Set the secrets (never commit these):

```bash
for S in PLAYHQ_API_KEY PLAYHQ_TENANT PLAYHQ_ORG_ID SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ADMIN_SECRET; do
  npx wrangler secret put $S --config wrangler-playhq-sync-bucc.toml
done
```

`ADMIN_SECRET` is any long random string; it gates the `/sync` and `/debug`
routes. Deploy:

```bash
npx wrangler deploy --config wrangler-playhq-sync-bucc.toml
```

Add the new config filename to the `WORKERS` array in `deploy-workers.sh`.

---

## 3. Point the club's app at its Worker

In that club's `index.html`, set in `CLUB_CONFIG`:

```js
playhqSyncUrl: 'https://playhq-sync-bucc.<subdomain>.workers.dev',
```

Also review these `CLUB_CONFIG` fields, which affect match screens:

- `matchGrades` — starting list for the manual "Schedule match" grade dropdown.
  This is only a seed: once fixtures are imported, the club's **real** PlayHQ
  grade names are merged in automatically, so an imperfect list self-corrects.
  For a non-cricket club, replace the XI naming entirely.
- `matchFormats` — same idea for match format (cricket defaults are 2 Day / One
  Day / T20 / Practice).

---

## 4. Verify before handing over

```bash
# Should list the club's current seasons
curl -s "https://playhq-sync-bucc.<subdomain>.workers.dev/seasons" | head

# Should list ONLY that club's teams for a season
curl -s "https://playhq-sync-bucc.<subdomain>.workers.dev/teams?season=<SEASON_ID>"
```

If `/teams` returns an empty list while the club clearly has teams on PlayHQ,
the `PLAYHQ_ORG_ID` is wrong or the club is not entered in that season yet.

Then, in the app as an admin: **Import Fixture** → confirm the listed teams and
game counts look right → **Import all**.

---

## How the sync behaves (same for every club)

- The first in-app import **activates** the nightly sync. Before that, the 3am
  cron does nothing.
- Once active, it syncs every non-completed season — current **and future** —
  adding new games and refreshing schedule changes. No further admin action is
  needed season to season.
- Admins get a push notification when new games are added.
- Admin edits to a fixture's **description** and **cost** survive re-syncs;
  `cancelled` is never overwritten by sync.
- Re-importing is idempotent — matched on `play_hq_id`, so rows update rather
  than duplicate.
- **Known limitation:** deleting a synced fixture in-app will bring it back at
  the next sync. Cancel it instead.

## Club-agnostic guarantees in the code

These were deliberately built to need no per-club changes:

- Club teams are matched by **organisation UUID** (`club.id`), with a name
  substring only as fallback.
- Home/away is decided by **team ID membership**, never by name matching — so a
  club whose PlayHQ names differ from its app branding still resolves correctly,
  including club-derby fixtures.
- Grade/format dropdowns self-populate from the club's actual events.
- Season status handling accepts `COMPLETED`/`COMPLETE` variants.
