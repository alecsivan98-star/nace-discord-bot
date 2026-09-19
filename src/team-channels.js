const { ChannelType, OverwriteType, PermissionsBitField } = require("discord.js");

// Serialize per leader, including fresh roster reads, so concurrent commands
// cannot create duplicate channels or restore an older membership snapshot.
function createTeamChannelManager(loadTeam) {
  const pending = new Map();
  return function syncTeamChannel(guild, leaderId) {
    const key = `${guild.id}:${leaderId}`;
    const operation = (pending.get(key) || Promise.resolve()).then(async () => {
      try {
        const team = await loadTeam(leaderId);
        const marker = `NACE_TEAM:${leaderId}`;
        const channels = await guild.channels.fetch();
        const matches = [...channels.values()].filter(channel =>
          channel?.type === ChannelType.GuildText && channel.topic === marker
        );
        if (matches.length > 1) throw new Error("Multiple channels have the same team marker");
        let channel = matches[0];
        if (!team && !channel) return { success: true, channel: null };

        const flags = PermissionsBitField.Flags;
        const bot = await guild.members.fetchMe();
        const permissionOverwrites = [
          { id: guild.id, type: OverwriteType.Role, deny: [flags.ViewChannel] },
          { id: bot.id, type: OverwriteType.Member,
            allow: [flags.ViewChannel, flags.SendMessages, flags.ReadMessageHistory,
              flags.ManageChannels, flags.ManageRoles] },
        ];
        if (team) {
          const ids = [leaderId, ...[1, 2, 3, 4, 5].map(n => team[`member_${n}`])];
          for (const id of new Set(ids.filter(id => id && id !== bot.id))) {
            permissionOverwrites.push({ id, type: OverwriteType.Member,
              allow: [flags.ViewChannel, flags.SendMessages, flags.ReadMessageHistory,
                flags.AttachFiles, flags.EmbedLinks] });
          }
        }
        const reason = "Synchronize NACE team channel";
        if (!channel) {
          const leader = await guild.members.fetch(leaderId);
          const slug = (leader.displayName || "lider").normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "").toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45) || "lider";
          channel = await guild.channels.create({
            name: `echipa-${slug}-${leaderId.slice(-6)}`,
            type: ChannelType.GuildText, topic: marker,
            permissionOverwrites, reason,
          });
        } else {
          // Replace the complete list: removed members must lose access.
          // On cancellation retain history for admins, with no team access.
          await channel.permissionOverwrites.set(permissionOverwrites, reason);
        }
        console.log(`Team channel synced: leader=${leaderId} channel=${channel.id} active=${Boolean(team)}`);
        return { success: true, channel: team ? channel : null };
      } catch (error) {
        console.error("syncTeamChannel:", error);
        return { success: false,
          error: "Canalul echipei nu a putut fi sincronizat. Administratorul trebuie să verifice permisiunile Manage Channels și Manage Roles ale botului, apoi să ruleze /team status." };
      }
    });
    pending.set(key, operation);
    void operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); });
    return operation;
  };
}

module.exports = { createTeamChannelManager };
