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
      grade: { id: t.grade?.id ?? null, name: t.grade?.name ?? null },
    }));
}

// The public API only exposes fixtures per TEAM (there is no per-grade
// fixture endpoint): GET /v1/teams/:id/fixture
function fetchTeamFixture(env, teamId) {
  return playhqFetchAll(env, `/v1/teams/${teamId}/fixture`);
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
function mapGame(game, clubTeamIds) {
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
    location: game.venue?.name ?? null,
    grade: game.grade?.name ?? null,
    grade_id: game.grade?.id ?? null,
    round: roundNumber(game.round),
    home_team: homeComp.name,
    away_team: awayComp.name,
    home_away: clubTeamIds.has(homeComp.id) ? "Home" : "Away",
    from_schedule: true,
  };
}

async function collectSeasonFixtures(env, seasonId) {
  const teams = await fetchClubTeams(env, seasonId);
  const clubTeamIds = new Set(teams.map((t) => t.id));
  const byId = new Map(); // dedupe: two club teams facing each other share one game
  for (const team of teams) {
    const games = await fetchTeamFixture(env, team.id);
    for (const game of games) {
      const row = mapGame(game, clubTeamIds);
      if (row) byId.set(row.play_hq_id, row);
    }
  }
  return [...byId.values()];
}

async function upsertEvents(env, events) {
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
      description: `Round ${r.round ?? "—"} · ${r.grade ?? ""} · Imported from PlayHQ`,
      cost: 0,
    }));
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
