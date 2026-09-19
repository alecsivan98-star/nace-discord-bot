const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, PermissionsBitField: { Flags } } = require("discord.js");
const { createTeamChannelManager } = require("./team-channels");

function fixture() {
  let roster = { member_1: "member-a" };
  const channels = new Map();
  const guild = {
    id: "guild", members: { fetchMe: async () => ({ id: "bot" }),
      fetch: async () => ({ displayName: "Alex" }) },
    channels: { fetch: async () => channels, create: async options => {
      const channel = { ...options, id: String(channels.size + 1),
        overwrites: options.permissionOverwrites,
        permissionOverwrites: { set: async values => { channel.overwrites = values; } } };
      channels.set(channel.id, channel);
      return channel;
    } },
  };
  return { guild, channels, setRoster: value => { roster = value; },
    sync: createTeamChannelManager(async () => roster) };
}

test("creates a private text channel once under concurrent requests and after restart", async () => {
  const f = fixture();
  const results = await Promise.all([f.sync(f.guild, "leader"), f.sync(f.guild, "leader")]);
  assert.ok(results.every(result => result.success));
  assert.equal(f.channels.size, 1);
  const channel = results[0].channel;
  assert.equal(channel.type, ChannelType.GuildText);
  assert.deepEqual(channel.overwrites.find(o => o.id === "guild").deny, [Flags.ViewChannel]);
  assert.deepEqual(channel.overwrites.map(o => o.id), ["guild", "bot", "leader", "member-a"]);
  assert.ok(channel.overwrites.find(o => o.id === "member-a").allow.includes(Flags.SendMessages));
  await createTeamChannelManager(async () => ({ member_1: "member-a" }))(f.guild, "leader");
  assert.equal(f.channels.size, 1);
});

test("updates membership, preserves channel on completion and revokes access on cancellation", async () => {
  const f = fixture();
  const { channel } = await f.sync(f.guild, "leader");
  f.setRoster({ id: "completed-team", member_1: "member-b" });
  const completed = await f.sync(f.guild, "leader");
  assert.equal(completed.channel.id, channel.id);
  assert.ok(!channel.overwrites.some(o => o.id === "member-a"));
  assert.ok(channel.overwrites.some(o => o.id === "member-b"));
  f.setRoster(null);
  assert.equal((await f.sync(f.guild, "leader")).channel, null);
  assert.deepEqual(channel.overwrites.map(o => o.id), ["guild", "bot"]);
  assert.equal(f.channels.size, 1);
});

test("database failure never changes channel access", async () => {
  const f = fixture();
  const { channel } = await f.sync(f.guild, "leader");
  const before = channel.overwrites;
  const sync = createTeamChannelManager(async () => { throw new Error("DB unavailable"); });
  assert.equal((await sync(f.guild, "leader")).success, false);
  assert.equal(channel.overwrites, before);
});

test("Discord permission error is reported and a later retry succeeds", async () => {
  const f = fixture();
  const create = f.guild.channels.create;
  f.guild.channels.create = async () => { throw new Error("Missing Permissions"); };
  assert.equal((await f.sync(f.guild, "leader")).success, false);
  f.guild.channels.create = create;
  assert.equal((await f.sync(f.guild, "leader")).success, true);
});
