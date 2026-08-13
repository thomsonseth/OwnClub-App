-- 006_followed_team.sql
-- Which team's fixtures a member wants surfaced on the Home screen.
-- NULL means "not chosen yet" — the app falls back to the club's first team
-- (see followedTeamOrDefault() in index.html).
-- Stores the team label (events.grade) rather than an ID, so it stays
-- club-agnostic and matches however that club's teams are named on PlayHQ.
alter table public.profiles add column if not exists followed_team text;
