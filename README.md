# NACE Assistant

Discord bot for NACE onboarding, screenshot verification, signals, bonuses and team management.

## Current capabilities

- Welcome DM with onboarding buttons and Romanian-language tutorials.
- Screenshot verification through OpenAI Vision; approval requires a clearly visible `Verified`, `Found Account` or `Trading Account`, and an amount of at least 500.
- `Trader` role assignment after approval.
- Normal signals at 12:10, 17:10 and 20:10 Europe/Bucharest, with same-minute duplicate protection.
- New-member bonus for three days, activated only after the member confirms in DM that they are connected to the professor's signals; Team Leader bonus for 20 days.
- `/status`; owner/admin-only `/team create`, `/team add`, `/team remove`, `/team cancel`, `/team status`; and administrator-only `/admin member`, `/admin team`, `/admin members`, `/admin teams`.
- Manual teams can be built one member at a time. The `Team Leader` role and its 20-day bonus start only after the fifth member is added.
- Invite tracking: five unique, unassigned referrals plus the inviter form an automatic six-person team. The inviter becomes `Team Leader`.

## Configuration

Copy `.env.example` to `.env` for local development, then configure the same variables in Railway. Do not commit `.env`.

Required: `DISCORD_TOKEN`, `GUILD_ID`, `TRADER_ROLE_ID`, `SUPABASE_URL`, `SUPABASE_KEY`.

`SUPABASE_KEY` must be the server-side Supabase service-role key when Row Level Security is enabled. Keep it only in Railway or a local `.env`; never share it in Discord or commit it to Git.

Optional: `OPENAI_API_KEY`, `OPENAI_MODEL`, `SIGNAL_CHANNEL_ID`, `NACE_URL`.

`JARVIS_OWNER_DISCORD_ID` is documented for the future personal JARVIS layer; JARVIS is not enabled for server members.

## Discord configuration

Enable the **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal. The bot needs Manage Roles to assign `Trader` and `Team Leader`, and Manage Server to fetch invites for referral tracking. It also needs View Channels, Send Messages, Send Messages in DMs, Read Message History, and Use Application Commands.

## Supabase

Run [`supabase/schema.sql`](supabase/schema.sql) before enabling automatic invite tracking or manual team drafts. Existing `members`, `teams`, and `signal_logs` tables must remain available.

## Start locally / Railway

Use Node.js 20 or later and run:

```bash
npm install
npm start
```

On Railway, set the environment variables from `.env.example`, choose Node 20+, and keep the start command as `npm start`.
