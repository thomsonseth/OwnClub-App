import { timingSafeEqual } from "node:crypto";

const PLAYHQ_BASE = "https://api.playhq.com";

// CORS: these proxy routes only expose publicly-viewable fixture data (the
// same data anyone can see on playhq.com) — the API key itself never leaves
// the Worker — so a wildcard origin is fine, same as rss-proxy.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function secretMatches(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Follows PlayHQ cursor pagination (metadata.hasMore/nextCursor) and returns
// the concatenated data array.
async function playhqFetchAll(env, path) {
  const all = [];
  let cursor = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${PLAYHQ_BASE}${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, {
      headers: {
        "x-api-key": env.PLAYHQ_API_KEY,
        "x-phq-tenant": env.PLAYHQ_TENANT,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PlayHQ GET ${path} -> ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    all.push(...(json.data ?? []));
    cursor = json.metadata?.hasMore ? json.metadata.nextCursor : null;
  } while (cursor);
  return all;
}

function fetchSeasons(env, orgId) {
  return playhqFetchAll(env, `/v1/organisations/${orgId}/seasons`);
}

// All teams in a season, filtered down to this club's. Primary match is
// club.id === PLAYHQ_ORG_ID (exact, club-agnostic); PLAYHQ_CLUB_NAME is a
// name-substring fallback for setups without the org UUID configured.
function isClubTeam(env, t) {
  if (env.PLAYHQ_ORG_ID && t.club?.id === env.PLAYHQ_ORG_ID) return true;
  const word = (env.PLAYHQ_CLUB_NAME || "").toLowerCase();
  if (!word) return false;
  return (t.club?.name ?? "").toLowerCase().includes(word) || (t.name ?? "").toLowerCase().includes(word);
}

async function fetchClubTeams(env, seasonId) {
  const teams = await playhqFetchAll(env, `/v1/seasons/${seasonId}/teams`);
  return teams
    .filter((t) => isClubTeam(env, t))
    .map((t) => ({
      id: t.id,
      name: t.name,
      clubName: t.club?.name ?? null,
      grade: { id: t.grade?.id ?? null, name: t.grade?.name ?? null },
    }));
}

// Generic club-type words that carry no team identity once the club name is
// already known. Used to reduce e.g. "Laurimar CC Spring Black" -> "Spring
// Black" after the club prefix is stripped.
const CLUB_WORDS = new Set([
  "cc", "fc", "afc", "sc", "cfc", "rfc", "hc", "bc", "lc", "tc",
  "club", "cricket", "football", "netball", "soccer", "basketball", "rugby",
  "hockey", "tennis", "athletics", "athletic", "sports", "sporting", "association", "inc",
]);

// The short label a club actually uses for one of its teams, derived by
// stripping the club name PlayHQ repeats on every team:
//   "Laurimar 1st XI"          + club "Laurimar Cricket Club" -> "1st XI"
//   "Laurimar CC Spring Black" + club "Laurimar Cricket Club" -> "Spring Black"
//   "BUCC Reserves"      + club "Bundoora United Cricket Club" -> "Reserves"
// When nothing distinguishing is left — the team name IS the club name, as
// with a single-team Summer Smash entry — the full name is kept.
// Club-agnostic: derived from PlayHQ's own club name, never a hardcoded word.
function clubTeamLabel(teamName, clubName) {
  const t = (teamName || "").trim();
  const c = (clubName || "").trim();
  if (!t) return null;
  if (!c) return t;
  const tw = t.split(/\s+/);
  const cw = c.split(/\s+/);
  let i = 0;
  while (i < tw.length && i < cw.length && tw[i].toLowerCase() === cw[i].toLowerCase()) i++;
  if (i >= tw.length) return t; // team name is exactly the club name
  const acronym = cw.map((w) => w[0]).join("").toLowerCase();
  let rest = tw.slice(i);
  while (rest.length) {
    const w = rest[0].toLowerCase().replace(/[^a-z]/g, "");
    if (CLUB_WORDS.has(w) || w === acronym) rest = rest.slice(1);
    else break;
  }
  if (!rest.length) return t; // nothing distinguishing left
  const out = rest.join(" ").trim();
  return out && out.toLowerCase() !== c.toLowerCase() ? out : t;
}

// The public API only exposes fixtures per TEAM (there is no per-grade
// fixture endpoint): GET /v1/teams/:id/fixture
function fetchTeamFixture(env, teamId) {
  return playhqFetchAll(env, `/v1/teams/${teamId}/fixture`);
}

// "McDonnell Park — Oval 1 - East". The surface is only appended when it adds
// something: some venues repeat the venue name as the surface name.
function venueLabel(venue) {
  const name = (venue?.name || "").trim();
  const surface = (venue?.surfaceName || "").trim();
  if (!name) return surface || null;
  if (!surface || surface.toLowerCase() === name.toLowerCase()) return name;
  return `${name} — ${surface}`;
}

function roundNumber(round) {
  const m = String(round?.name ?? round?.abbreviatedName ?? "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

// Map a PlayHQ game object to an OwnClub events row. Home/away is decided by
// whether the home competitor's TEAM ID belongs to this club — never by name
// matching, which breaks for clubs whose PlayHQ names differ from their app
// branding. Game shape: competitors[{id,name,isHomeTeam}],
// schedule{date,time,timezone}, venue{name}, grade{id,name}, round{name}.
function mapGame(game, clubTeamIds, team) {
  const competitors = Array.isArray(game.competitors) ? game.competitors : [];
  const homeComp = competitors.find((c) => c.isHomeTeam);
  const awayComp = competitors.find((c) => !c.isHomeTeam);
  if (!homeComp?.name || !awayComp?.name) return null; // bye / not yet scheduled
  const date = game.schedule?.date || null;
  if (!date) return null; // unscheduled games have empty dates
  const time = (game.schedule?.time || "").slice(0, 5) || null;

  return {
    play_hq_id: game.id,
    type: "match",
    title: `${homeComp.name} vs ${awayComp.name}`,
    date,
    time,
    finish_date: date,
    // Venue plus the specific playing surface PlayHQ assigns ("McDonnell Park
    // — Oval 1 - East"), which is what tells players which ground to walk to.
    // The " — " separator is what map links split on, so the query stays the
    // venue itself (see mapsQuery() in index.html).
    location: venueLabel(game.venue),
    // `grade` groups matches in the app, so it holds the club's own team label
    // ("1st XI") rather than the competition grade ("04 - Dyson Shield"), which
    // stays visible in the description. Keeps imported fixtures and manually
    // scheduled matches speaking the same vocabulary.
    grade: clubTeamLabel(team?.name, team?.clubName) ?? game.grade?.name ?? null,
    grade_id: game.grade?.id ?? null,
    // Not an events column — used only to build the description below, and
    // stripped by stripMeta() before anything is sent to Supabase.
    _competitionGrade: game.grade?.name ?? null,
    round: roundNumber(game.round),
    home_team: homeComp.name,
    away_team: awayComp.name,
    home_away: clubTeamIds.has(homeComp.id) ? "Home" : "Away",
    from_schedule: true,
  };
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// PlayHQ's public API does not publish the match type (One Day / Two Day) —
// it exists only on their website, behind a private endpoint with
// introspection disabled. It is, however, determined by the GRADE's round
// calendar: a two-day game occupies its date and the following week, so the
// grade's next round cannot begin for a fortnight, whereas a one-day round is
// followed a week later.
//
// The calendar is read from the whole grade (/v1/grades/:id/games), not just
// our own team's fixture, so a bye or an unscheduled game for our side can't
// shift the spacing and produce a wrong answer.
//
// Opt in per club with PLAYHQ_TWO_DAY_FORMAT — without it this does nothing,
// so a sport running fortnightly fixtures isn't told every game is two-day.
// Results go to `_format` (meta): the sync applies them to new games only, so
// an admin's own correction is never overwritten.
function buildRoundCalendar(games) {
  const earliest = new Map(); // round -> first date that round is played
  for (const g of games) {
    const date = g.schedule?.date;
    const key = g.round?.id || g.round?.name;
    if (!date || !key) continue;
    if (!earliest.has(key) || date < earliest.get(key)) earliest.set(key, date);
  }
  return [...earliest.entries()]
    .map(([id, date]) => ({ id: String(id), date }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function deriveMatchTypes(env, rows, gradeCalendar) {
  const twoDay = env.PLAYHQ_TWO_DAY_FORMAT;
  const oneDay = env.PLAYHQ_ONE_DAY_FORMAT;
  if (!twoDay) return;

  // Fall back to our own fixture's spacing if the grade calendar is missing.
  const cal = gradeCalendar?.length
    ? gradeCalendar
    : [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((r) => ({ id: String(r._roundId), date: r.date }));
  const posOf = new Map(cal.map((c, i) => [c.id, i]));

  for (const row of rows) {
    const i = posOf.get(String(row._roundId));
    if (i == null) continue;
    const next = cal[i + 1];
    if (!next) {
      // Final round of the grade: nothing follows it to measure against, so
      // this is the one case the calendar can't answer. PLAYHQ_LAST_ROUND_FORMAT
      // states the club's convention rather than leaving it blank.
      if (env.PLAYHQ_LAST_ROUND_FORMAT) row._format = env.PLAYHQ_LAST_ROUND_FORMAT;
      continue;
    }
    const gap = (Date.parse(next.date) - Date.parse(row.date)) / 86400000;
    if (gap <= 7) {
      if (oneDay) row._format = oneDay;
    } else if (gap >= 14) {
      // Includes gaps longer than a fortnight: a mid-season break follows the
      // second day, it doesn't replace it.
      row._format = twoDay;
      row.finish_date = addDays(row.date, 7);
    }
    // 8-13 days is neither pattern — left unset rather than guessed.
  }
}

async function collectSeasonFixtures(env, seasonId) {
  const teams = await fetchClubTeams(env, seasonId);
  const clubTeamIds = new Set(teams.map((t) => t.id));
  const calendars = new Map(); // gradeId -> round calendar, fetched once per grade
  const byId = new Map(); // dedupe: two club teams facing each other share one game

  for (const team of teams) {
    const games = await fetchTeamFixture(env, team.id);
    const rows = [];
    for (const game of games) {
      const row = mapGame(game, clubTeamIds, team);
      if (row) {
        row._roundId = String(game.round?.id || game.round?.name || "");
        rows.push(row);
      }
    }

    const gradeId = team.grade?.id;
    if (gradeId && !calendars.has(gradeId)) {
      try {
        calendars.set(gradeId, buildRoundCalendar(await playhqFetchAll(env, `/v1/grades/${gradeId}/games`)));
      } catch (err) {
        console.error(`grade calendar ${gradeId} failed`, err);
        calendars.set(gradeId, null); // derivation falls back to our own spacing
      }
    }
    deriveMatchTypes(env, rows, gradeId ? calendars.get(gradeId) : null);
    for (const row of rows) byId.set(row.play_hq_id, row);
  }
  return [...byId.values()];
}

// Drop internal `_`-prefixed helper fields — PostgREST rejects any key that
// isn't a real column.
function stripMeta(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

async function upsertEvents(env, rows) {
  const events = rows.map(stripMeta);
  if (events.length === 0) return 0;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/events?on_conflict=play_hq_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(events),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upsert -> ${res.status}: ${body.slice(0, 500)}`);
  }
  return events.length;
}

async function supabaseGet(env, pathAndQuery) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery} -> ${res.status}`);
  return res.json();
}

async function fetchImportedPlayhqIds(env) {
  const rows = await supabaseGet(env, "events?select=play_hq_id&play_hq_id=not.is.null");
  return new Set(rows.map((r) => r.play_hq_id));
}

// Push a notification to club Administrators via the existing onesignal-proxy
// Worker (which holds the OneSignal credentials). Worker-to-worker fetches
// send no Origin header, which the proxy's origin check permits.
async function notifyAdmins(env, title, message) {
  if (!env.ONESIGNAL_PROXY_URL) return;
  const admins = await supabaseGet(env, "profiles?select=id&role=eq.Administrator&onboarding_complete=eq.true");
  const ids = admins.map((a) => a.id);
  if (!ids.length) return;
  const res = await fetch(env.ONESIGNAL_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      include_aliases: { external_id: ids },
      target_channel: "push",
      headings: { en: title },
      contents: { en: message.slice(0, 200) },
      url: env.APP_URL || "/",
    }),
  });
  if (!res.ok) console.error(`notifyAdmins -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Nightly full sync. Once the admin has done the initial in-app import (any
// play_hq_id exists in events), every non-completed season — current AND
// future — is synced automatically: new games are added, existing ones have
// their schedule details refreshed. New-game rows carry a description;
// refresh rows deliberately omit description/cost so admin edits to those
// fields survive.
async function runSync(env) {
  const imported = await fetchImportedPlayhqIds(env);
  if (imported.size === 0) return { synced: 0, added: 0, fixtures: [] }; // not activated yet

  let seasonIds = [];
  if (env.PLAYHQ_ORG_ID) {
    const seasons = await fetchSeasons(env, env.PLAYHQ_ORG_ID);
    seasonIds = seasons.filter((s) => !String(s.status).startsWith("COMPLETE")).map((s) => s.id);
  } else if (env.PLAYHQ_SEASON_ID) {
    seasonIds = [env.PLAYHQ_SEASON_ID];
  }

  const fixtures = [];
  for (const seasonId of seasonIds) {
    fixtures.push(...(await collectSeasonFixtures(env, seasonId)));
  }

  const newRows = fixtures
    .filter((r) => !imported.has(r.play_hq_id))
    .map((r) => ({
      ...r,
      description: `Round ${r.round ?? "—"} · ${r._competitionGrade || r.grade || ""} · Imported from PlayHQ`,
      cost: 0,
      // Derived match type, applied only when a game is first seen. Always
      // present so the batch has uniform columns.
      format: r._format ?? null,
    }));
  // Updates deliberately carry no `format` column, so an admin's own match
  // type survives every future sync.
  const updateRows = fixtures.filter((r) => imported.has(r.play_hq_id));

  // Two upserts: PostgREST bulk requests need uniform columns per batch.
  await upsertEvents(env, newRows);
  await upsertEvents(env, updateRows);

  if (newRows.length > 0) {
    const grades = [...new Set(newRows.map((r) => r.grade).filter(Boolean))];
    await notifyAdmins(
      env,
      "New fixtures on PlayHQ",
      `${newRows.length} new game${newRows.length !== 1 ? "s" : ""} added to the app${grades.length ? ` (${grades.slice(0, 3).join(", ")}${grades.length > 3 ? "…" : ""})` : ""}.`
    ).catch((err) => console.error("notifyAdmins failed", err));
  }

  return { synced: fixtures.length, added: newRows.length, fixtures };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ── Public read-only proxy routes for the in-app import wizard ──
      if (url.pathname === "/seasons") {
        const orgId = env.PLAYHQ_ORG_ID || url.searchParams.get("org");
        if (!orgId) {
          return corsJson({ error: "Organisation ID not configured. Set the PLAYHQ_ORG_ID secret or pass ?org=." }, 400);
        }
        const seasons = await fetchSeasons(env, orgId);
        // Current seasons first — the club competes in several competitions,
        // so the raw list buries UPCOMING/ACTIVE among old COMPLETED ones.
        const rank = (s) => (String(s.status).startsWith("COMPLETE") ? 1 : 0);
        seasons.sort((a, b) => rank(a) - rank(b));
        return corsJson({ data: seasons });
      }

      if (url.pathname === "/teams") {
        const seasonId = url.searchParams.get("season");
        if (!seasonId) return corsJson({ error: "Missing ?season=" }, 400);
        return corsJson({ data: await fetchClubTeams(env, seasonId) });
      }

      if (url.pathname === "/gradegames") {
        const g = url.searchParams.get("grade");
        if (!g) return corsJson({ error: "Missing ?grade=" }, 400);
        return corsJson({ data: await playhqFetchAll(env, `/v1/grades/${g}/games`) });
      }

      if (url.pathname === "/fixture") {
        const teamId = url.searchParams.get("team");
        if (!teamId) return corsJson({ error: "Missing ?team=" }, 400);
        return corsJson({ data: await fetchTeamFixture(env, teamId) });
      }

      // ── Secret-gated admin/cron routes ──
      const secret = url.searchParams.get("secret");

      if (url.pathname === "/debug") {
        if (!secretMatches(secret, env.ADMIN_SECRET)) return new Response("Unauthorized", { status: 401 });
        const seasonId = url.searchParams.get("season") || env.PLAYHQ_SEASON_ID;
        const fixtures = seasonId ? await collectSeasonFixtures(env, seasonId) : [];
        return Response.json({ count: fixtures.length, fixtures });
      }

      if (url.pathname === "/sync") {
        if (!secretMatches(secret, env.ADMIN_SECRET)) return new Response("Unauthorized", { status: 401 });
        const { synced, added } = await runSync(env);
        return Response.json({ synced, added });
      }
    } catch (err) {
      return corsJson({ error: err.message }, 500);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runSync(env)
        .then(({ synced, added }) => console.log(`playhq-sync cron: synced ${synced} fixtures (${added} new)`))
        .catch((err) => console.error("playhq-sync cron failed", err))
    );
  },
};
