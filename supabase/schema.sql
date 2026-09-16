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

-- Before production, verify that existing public.members contains:
-- discord_id, username, is_team_leader, team_id, team_bonus_start,
-- team_bonus_end, new_member_bonus_start, new_member_bonus_end, updated_at.
-- Verify that public.teams contains leader_discord_id, member_1 through
-- member_5, formed_at, bonus_start and bonus_end. Do not run an ALTER TABLE
-- migration with guessed types; this repository does not include the live DB schema.
