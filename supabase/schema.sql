-- Run this in the Supabase SQL editor before enabling automatic invite tracking.
-- It adds only the referral data needed by the bot and does not remove data.

create table if not exists public.referrals (
  referred_discord_id text primary key,
  inviter_discord_id text not null,
  invite_code text,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists referrals_inviter_joined_at_idx
  on public.referrals (inviter_discord_id, joined_at);

-- Pending manual teams. These rows do not grant the Team Leader role or bonus.
-- A completed team is created in public.teams only after all five member slots
-- are filled. This leaves the existing teams table and its constraints intact.
create table if not exists public.team_drafts (
  leader_discord_id text primary key,
  member_1 text,
  member_2 text,
  member_3 text,
  member_4 text,
  member_5 text,
  is_finalizing boolean not null default false,
  finalizing_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.team_drafts enable row level security;

create index if not exists team_drafts_member_1_idx
  on public.team_drafts (member_1);
create index if not exists team_drafts_member_2_idx
  on public.team_drafts (member_2);
create index if not exists team_drafts_member_3_idx
  on public.team_drafts (member_3);
create index if not exists team_drafts_member_4_idx
  on public.team_drafts (member_4);
create index if not exists team_drafts_member_5_idx
  on public.team_drafts (member_5);

-- Before production, verify that existing public.members contains:
-- discord_id, username, is_team_leader, team_id, team_bonus_start,
-- team_bonus_end, new_member_bonus_start, new_member_bonus_end, updated_at.
-- Verify that public.teams contains leader_discord_id, member_1 through
-- member_5, formed_at, bonus_start and bonus_end. Do not run an ALTER TABLE
-- migration with guessed types; this repository does not include the live DB schema.
