# JARVIS (reserved personal layer)

JARVIS is intentionally separate from the public NACE Assistant workflows.
When implemented, its command or DM handler must first compare the requesting Discord user ID with `JARVIS_OWNER_DISCORD_ID`. It must reject every other user without exposing private context, credentials, or server-member data.

No JARVIS command is active yet.
