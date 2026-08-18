-- 007_team_logos.sql
-- Club crests for the two sides of an imported fixture, as served by PlayHQ's
-- CDN (club.logo.sizes[] on /v1/seasons/{id}/teams). Stored per event rather
-- than resolved at render time because the opponent's club is not otherwise
-- known to the app. Null for manually scheduled matches.
alter table public.events add column if not exists home_logo text;
alter table public.events add column if not exists away_logo text;
