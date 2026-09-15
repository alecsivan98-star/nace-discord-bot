require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

/* =========================
   CONFIG
========================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TRADER_ROLE_ID = process.env.TRADER_ROLE_ID;
const NACE_URL = process.env.NACE_URL || "https://nacetuin.com/";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SIGNAL_CHANNEL_ID = process.env.SIGNAL_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  console.error("Lipseste DISCORD_TOKEN");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("Lipseste GUILD_ID");
  process.exit(1);
}

if (!TRADER_ROLE_ID) {
  console.error("Lipseste TRADER_ROLE_ID");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Lipsesc SUPABASE_URL sau SUPABASE_KEY");
  process.exit(1);
}

/* =========================
   CLIENTS
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
    })
  : null;

/* =========================
   DATABASE
========================= */

async function saveMember(member) {
  const { error } = await supabase
    .from("members")
    .upsert(
      {
        discord_id: member.id,
        username: member.user.username,
      },
      {
        onConflict: "discord_id",
      }
    );

  if (error) {
    console.error("saveMember:", error);
  }
}

async function getMemberData(discordId) {
  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error) {
    console.error("getMemberData:", error);
    return null;
  }

  return data;
}

async function activateNewMemberBonus(discordId) {
  const start = new Date();
  const end = new Date(
    start.getTime() + 3 * 24 * 60 * 60 * 1000
  );

  const { error } = await supabase
    .from("members")
    .update({
      new_member_bonus_start: start.toISOString(),
      new_member_bonus_end: end.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("discord_id", discordId);

  if (error) {
    console.error("activateNewMemberBonus:", error);
  }
}

async function createTeamInDatabase(
  leaderId,
  memberIds
) {
  if (memberIds.length !== 5) {
    return {
      success: false,
      error: "O echipă trebuie să aibă exact 5 membri.",
    };
  }

  const formedAt = new Date();

  const bonusEnd = new Date(
    formedAt.getTime() +
      20 * 24 * 60 * 60 * 1000
  );

  const { data: team, error: teamError } =
    await supabase
      .from("teams")
      .insert({
        leader_discord_id: leaderId,
        member_1: memberIds[0],
        member_2: memberIds[1],
        member_3: memberIds[2],
        member_4: memberIds[3],
        member_5: memberIds[4],
        formed_at: formedAt.toISOString(),
        bonus_start: formedAt.toISOString(),
        bonus_end: bonusEnd.toISOString(),
      })
      .select()
      .single();

  if (teamError) {
    console.error("createTeam:", teamError);

    return {
      success: false,
      error: "Nu am putut crea echipa în baza de date.",
    };
  }

  for (const memberId of memberIds) {
    const isLeader = memberId === leaderId;

    await supabase
      .from("members")
      .upsert(
        {
          discord_id: memberId,
          is_team_leader: isLeader,
          team_id: team.id,
          team_bonus_start: isLeader
            ? formedAt.toISOString()
            : null,
          team_bonus_end: isLeader
            ? bonusEnd.toISOString()
            : null,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "discord_id",
        }
      );
  }

  return {
    success: true,
    team,
  };
}

/* =========================
   SCREENSHOT VERIFICATION
========================= */

async function verifyScreenshot(imageUrl) {
  if (!openai) {
    console.error(
      "OPENAI_API_KEY lipseste."
    );

    return {
      approved: false,
    };
  }

  try {
    const response =
      await openai.responses.create({
        model: OPENAI_MODEL,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Verifica acest screenshot pentru un cont crypto NACE. " +
                  "Aprobă DOAR dacă sunt vizibile clar: " +
                  "1. cuvantul Verified, " +
                  "2. Found Account sau Trading Account, " +
                  "3. o suma numerica de minimum 500. " +
                  "Nu solicita si nu extrage parole, seed phrase, private keys sau coduri 2FA. " +
                  "Raspunde strict cu APPROVED sau REJECTED.",
              },
              {
                type: "input_image",
                image_url: imageUrl,
              },
            ],
          },
        ],
      });

    const text =
      response.output_text
        ?.trim()
        .toUpperCase() || "";

    return {
      approved: text.includes("APPROVED"),
    };
  } catch (error) {
    console.error(
      "verifyScreenshot:",
      error
    );

    return {
      approved: false,
    };
  }
}

/* =========================
   SIGNALS
========================= */

const SIGNAL_TIMES = {
  signal_1: "12:10",
  signal_2: "17:10",
  signal_3: "20:10",
  new_member: "13:00",
  team_leader: "12:30",
};

const NORMAL_SIGNAL_ROLES = [
  "Trader",
  "Team Leader",
  "Moderator",
  "Admin",
];

let lastSignalKey = "";

function getRomaniaTime() {
  return new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Europe/Bucharest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
  ).formatToParts(new Date());
}

function currentRomaniaHourMinute() {
  const parts = getRomaniaTime();

  const map = {};

  for (const part of parts) {
    map[part.type] = part.value;
  }

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: map.hour,
    minute: map.minute,
  };
}

function signalMessage(type) {
  if (type === "signal_1") {
    return "🚨 **NACE SIGNAL — 12:10**\n\nPrimul semnal al zilei.";
  }

  if (type === "signal_2") {
    return "🚨 **NACE SIGNAL — 17:10**\n\nAl doilea semnal al zilei.";
  }

  if (type === "signal_3") {
    return "🚨 **NACE SIGNAL — 20:10**\n\nAl treilea semnal al zilei.";
  }

  if (type === "new_member") {
    return "🎁 **NACE BONUS SIGNAL — 13:00**\n\nSemnal bonus pentru membrii noi.";
  }

  if (type === "team_leader") {
    return "👑 **NACE TEAM LEADER SIGNAL — 12:30**\n\nSemnal bonus Team Leader.";
  }

  return "📢 NACE SIGNAL";
}

async function logSignal(
  type,
  channelId,
  messageId
) {
  const { error } = await supabase
    .from("signal_logs")
    .insert({
      signal_type: type,
      discord_channel_id: channelId,
      message_id: messageId,
    });

  if (error) {
    console.error("logSignal:", error);
  }
}

async function sendNormalSignal(type) {
  if (!SIGNAL_CHANNEL_ID) {
    console.error(
      "SIGNAL_CHANNEL_ID nu este setat."
    );
    return;
  }

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const channel =
      await guild.channels.fetch(
        SIGNAL_CHANNEL_ID
      );

    if (!channel) {
      console.error(
        "Canalul de signal nu a fost găsit."
      );
      return;
    }

    const mentions = [];

    for (const roleName of NORMAL_SIGNAL_ROLES) {
      const role =
        guild.roles.cache.find(
          r => r.name === roleName
        );

      if (role) {
        mentions.push(`<@&${role.id}>`);
      }
    }

    const message = await channel.send({
      content:
        `${mentions.join(" ")}\n\n` +
        signalMessage(type),
      allowedMentions: {
        roles: mentions.map(x =>
          x.replace(/[<@&>]/g, "")
        ),
      },
    });

    await logSignal(
      type,
      channel.id,
      message.id
    );
  } catch (error) {
    console.error(
      "sendNormalSignal:",
      error
    );
  }
}

async function sendEligibleNewMemberSignal() {
  if (!SIGNAL_CHANNEL_ID) return;

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("members")
    .select("*")
    .lte(
      "new_member_bonus_start",
      now
    )
    .gte(
      "new_member_bonus_end",
      now
    );

  if (error) {
    console.error(
      "new member signal:",
      error
    );
    return;
  }

  if (!data || data.length === 0) return;

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const channel =
      await guild.channels.fetch(
        SIGNAL_CHANNEL_ID
      );

    const mentions = data.map(
      member =>
        `<@${member.discord_id}>`
    );

    const message = await channel.send({
      content:
        `${mentions.join(" ")}\n\n` +
        signalMessage("new_member"),
      allowedMentions: {
        users: data.map(
          member => member.discord_id
        ),
      },
    });

    await logSignal(
      "new_member",
      channel.id,
      message.id
    );
  } catch (error) {
    console.error(
      "sendEligibleNewMemberSignal:",
      error
    );
  }
}

async function sendEligibleTeamLeaderSignal() {
  if (!SIGNAL_CHANNEL_ID) return;

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("is_team_leader", true)
    .lte(
      "team_bonus_start",
      now
    )
    .gte(
      "team_bonus_end",
      now
    );

  if (error) {
    console.error(
      "team leader signal:",
      error
    );
    return;
  }

  if (!data || data.length === 0) return;

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const channel =
      await guild.channels.fetch(
        SIGNAL_CHANNEL_ID
      );

    const mentions = data.map(
      member =>
        `<@${member.discord_id}>`
    );

    const message = await channel.send({
      content:
        `${mentions.join(" ")}\n\n` +
        signalMessage("team_leader"),
      allowedMentions: {
        users: data.map(
          member => member.discord_id
        ),
      },
    });

    await logSignal(
      "team_leader",
      channel.id,
      message.id
    );
  } catch (error) {
    console.error(
      "sendEligibleTeamLeaderSignal:",
      error
    );
  }
}

async function checkSignals() {
  try {
    const time =
      currentRomaniaHourMinute();

    const key =
      `${time.date}-${time.hour}:${time.minute}`;

    if (key === lastSignalKey) {
      return;
    }

    if (
      time.hour === "12" &&
      time.minute === "10"
    ) {
      await sendNormalSignal(
        "signal_1"
      );

      lastSignalKey = key;
      return;
    }

    if (
      time.hour === "17" &&
      time.minute === "10"
    ) {
      await sendNormalSignal(
        "signal_2"
      );

      lastSignalKey = key;
      return;
    }

    if (
      time.hour === "20" &&
      time.minute === "10"
    ) {
      await sendNormalSignal(
        "signal_3"
      );

      lastSignalKey = key;
      return;
    }

    if (
      time.hour === "13" &&
      time.minute === "00"
    ) {
      await sendEligibleNewMemberSignal();

      lastSignalKey = key;
      return;
    }

    if (
      time.hour === "12" &&
      time.minute === "30"
    ) {
      await sendEligibleTeamLeaderSignal();

      lastSignalKey = key;
      return;
    }
  } catch (error) {
    console.error(
      "checkSignals:",
      error
    );
  }
}

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription(
      "Vezi statusul tau NACE"
    ),

  new SlashCommandBuilder()
    .setName("team")
    .setDescription(
      "Gestionare echipe"
    )
    .addSubcommand(sub =>
      sub
        .setName("create")
        .setDescription(
          "Creeaza o echipa de 5 membri"
        )
        .addUserOption(option =>
          option
            .setName("member1")
            .setDescription(
              "Team Leader"
            )
            .setRequired(true)
        )
        .addUserOption(option =>
          option
            .setName("member2")
            .setDescription(
              "Membru 2"
            )
            .setRequired(true)
        )
        .addUserOption(option =>
          option
            .setName("member3")
            .setDescription(
              "Membru 3"
            )
            .setRequired(true)
        )
        .addUserOption(option =>
          option
            .setName("member4")
            .setDescription(
              "Membru 4"
            )
            .setRequired(true)
        )
        .addUserOption(option =>
          option
            .setName("member5")
            .setDescription(
              "Membru 5"
            )
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("admin")
    .setDescription(
      "Comenzi administrative"
    )
    .addSubcommand(sub =>
      sub
        .setName("member")
        .setDescription(
          "Vezi informatiile unui membru"
        )
        .addUserOption(option =>
          option
            .setName("user")
            .setDescription(
              "Membrul"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("team")
        .setDescription(
          "Vezi informatiile unei echipe"
        )
        .addUserOption(option =>
          option
            .setName("leader")
            .setDescription(
              "Team Leader"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("members")
        .setDescription(
          "Vezi membrii activi"
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("teams")
        .setDescription(
          "Vezi echipele"
        )
    ),
];

/* =========================
   REGISTER COMMANDS
========================= */

async function registerCommands() {
  try {
    const rest =
      new REST({
        version: "10",
      }).setToken(
        DISCORD_TOKEN
      );

    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        GUILD_ID
      ),
      {
        body: commands.map(
          command =>
            command.toJSON()
        ),
      }
    );

    console.log(
      "Slash commands registered."
    );
  } catch (error) {
    console.error(
      "registerCommands:",
      error
    );
  }
}

/* =========================
   BOT READY
========================= */

client.once("ready", async () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );

  await registerCommands();

  console.log(
    "NACE Assistant is online."
  );

  checkSignals();

  setInterval(
    checkSignals,
    30000
  );
});

/* =========================
   MEMBER JOIN / WELCOME
========================= */

client.on(
  "guildMemberAdd",
  async member => {
    try {
      console.log(
        `New member: ${member.user.tag}`
      );

      await saveMember(member);

      await activateNewMemberBonus(
        member.id
      );

      const row1 =
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(
              "register_nace"
            )
            .setLabel(
              "🚀 Înregistrare NACE"
            )
            .setStyle(
              ButtonStyle.Primary
            ),

          new ButtonBuilder()
            .setCustomId(
              "funding"
            )
            .setLabel(
              "💰 Alimentare cont"
            )
            .setStyle(
              ButtonStyle.Success
            )
        );

      const row2 =
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(
              "copy_trading"
            )
            .setLabel(
              "📈 Copy Trading"
            )
            .setStyle(
              ButtonStyle.Secondary
            ),

          new ButtonBuilder()
            .setCustomId(
              "verify_account"
            )
            .setLabel(
              "📸 Verificare cont"
            )
            .setStyle(
              ButtonStyle.Primary
            )
        );

      await member.send({
        content:
          `👋 **Salut ${member.user.username}!**\n\n` +
          `Bine ai venit în **NACE**! 🚀\n\n` +
          `Sunt asistentul NACE și te pot ajuta cu înregistrarea, alimentarea contului, Copy Trading și verificarea contului.\n\n` +
          `🎁 Ai primit automat perioada de bonus pentru membru nou, timp de **3 zile**.\n\n` +
          `Alege una dintre opțiunile de mai jos:`,
        components: [
          row1,
          row2,
        ],
      });

      console.log(
        `Welcome DM sent to ${member.user.tag}`
      );
    } catch (error) {
      console.error(
        "guildMemberAdd:",
        error
      );
    }
  }
);

/* =========================
   BUTTONS
========================= */

client.on(
  "interactionCreate",
  async interaction => {
    if (!interaction.isButton()) {
      return;
    }

    try {
      if (
        interaction.customId ===
        "register_nace"
      ) {
        await interaction.reply({
          content:
            `🚀 **Înregistrare NACE**\n\n` +
            `Accesează:\n${NACE_URL}\n\n` +
            `După înregistrare, revino aici pentru verificare.`,
          ephemeral: true,
        });

        return;
      }

      if (
        interaction.customId ===
        "funding"
      ) {
        const row =
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(
                "fund_okx"
              )
              .setLabel("OKX")
              .setStyle(
                ButtonStyle.Primary
              ),

            new ButtonBuilder()
              .setCustomId(
                "fund_binance"
              )
              .setLabel(
                "Binance"
              )
              .setStyle(
                ButtonStyle.Primary
              ),

            new ButtonBuilder()
              .setCustomId(
                "fund_bitget"
              )
              .setLabel(
                "Bitget"
              )
              .setStyle(
                ButtonStyle.Primary
              )
          );

        await interaction.reply({
          content:
            "💰 **Alege platforma:**",
          components: [row],
          ephemeral: true,
        });

        return;
      }

      if (
        [
          "fund_okx",
          "fund_binance",
          "fund_bitget",
        ].includes(
          interaction.customId
        )
      ) {
        await interaction.reply({
          content:
            "📸 După alimentare, trimite aici screenshot-ul contului.\n\n" +
            "Trebuie să fie vizibile clar:\n" +
            "• Verified\n" +
            "• Found Account sau Trading Account\n" +
            "• suma de minimum 500\n\n" +
            "Nu trimite parole, seed phrase, private keys sau coduri 2FA.",
          ephemeral: true,
        });

        return;
      }

      if (
        interaction.customId ===
        "copy_trading"
      ) {
        await interaction.reply({
          content:
            "📈 **Copy Trading**\n\n" +
            "Pentru informații despre Copy Trading, contactează echipa NACE.",
          ephemeral: true,
        });

        return;
      }

      if (
        interaction.customId ===
        "verify_account"
      ) {
        await interaction.reply({
          content:
            "📸 **Verificare cont**\n\n" +
            "Trimite screenshot-ul aici în DM.\n\n" +
            "Trebuie să se vadă:\n" +
            "• Verified\n" +
            "• Found Account sau Trading Account\n" +
            "• suma de minimum 500",
          ephemeral: true,
        });

        return;
      }
    } catch (error) {
      console.error(
        "button interaction:",
        error
      );

      if (!interaction.replied) {
        await interaction.reply({
          content:
            "❌ A apărut o eroare.",
          ephemeral: true,
        });
      }
    }
  }
);

/* =========================
   SLASH COMMAND INTERACTIONS
========================= */

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    try {
      /* STATUS */

      if (
        interaction.commandName ===
        "status"
      ) {
        const data =
          await getMemberData(
            interaction.user.id
          );

        if (!data) {
          await interaction.reply(
            "Nu există date pentru contul tău."
          );
          return;
        }

        const now = new Date();

        const newBonusActive =
          data.new_member_bonus_end &&
          new Date(
            data.new_member_bonus_end
          ) > now;

        const teamBonusActive =
          data.team_bonus_end &&
          new Date(
            data.team_bonus_end
          ) > now;

        await interaction.reply(
          `📊 **Status NACE — ${interaction.user.username}**\n\n` +
          `🎁 Bonus membru nou: ${
            newBonusActive
              ? "ACTIV"
              : "INACTIV"
          }\n` +
          `👑 Team Leader: ${
            data.is_team_leader
              ? "DA"
              : "NU"
          }\n` +
          `🏆 Bonus Team Leader: ${
            teamBonusActive
              ? "ACTIV"
              : "INACTIV"
          }`
        );

        return;
      }

      /* TEAM CREATE */

      if (
        interaction.commandName ===
          "team" &&
        interaction.options.getSubcommand() ===
          "create"
      ) {
        if (
          !interaction.member.permissions.has(
            PermissionsBitField.Flags
              .ManageGuild
          )
        ) {
          await interaction.reply({
            content:
              "❌ Nu ai permisiunea necesară.",
            ephemeral: true,
          });

          return;
        }

        const members = [];

        for (
          let i = 1;
          i <= 5;
          i++
        ) {
          const user =
            interaction.options.getUser(
              `member${i}`
            );

          members.push(user);
        }

        const ids =
          members.map(
            user => user.id
          );

        if (
          new Set(ids).size !== 5
        ) {
          await interaction.reply({
            content:
              "❌ Nu poți introduce același membru de mai multe ori.",
            ephemeral: true,
          });

          return;
        }

        const leader =
          members[0];

        const result =
          await createTeamInDatabase(
            leader.id,
            ids
          );

        if (!result.success) {
          await interaction.reply({
            content:
              `❌ ${result.error}`,
            ephemeral: true,
          });

          return;
        }

        const leaderMember =
          await interaction.guild.members.fetch(
            leader.id
          );

        const teamLeaderRole =
          interaction.guild.roles.cache.find(
            role =>
              role.name ===
              "Team Leader"
          );

        if (teamLeaderRole) {
          await leaderMember.roles.add(
            teamLeaderRole
          );
        }

        await interaction.reply(
          `✅ **Echipa a fost creată!**\n\n` +
          `👑 Team Leader: ${leader}\n` +
          `👥 Membri: ${members
            .slice(1)
            .join(", ")}\n\n` +
          `🎁 Bonus Team Leader activ timp de **20 de zile**.\n` +
          `⏰ Semnal bonus zilnic la **12:30**.`
        );

        return;
      }

      /* ADMIN */

      if (
        interaction.commandName ===
        "admin"
      ) {
        if (
          !interaction.member.permissions.has(
            PermissionsBitField.Flags
              .Administrator
          )
        ) {
          await interaction.reply({
            content:
              "❌ Nu ai permisiune de Administrator.",
            ephemeral: true,
          });

          return;
        }

        const subcommand =
          interaction.options.getSubcommand();

        /* ADMIN MEMBER */

        if (
          subcommand === "member"
        ) {
          const user =
            interaction.options.getUser(
              "user"
            );

          const data =
            await getMemberData(
              user.id
            );

          if (!data) {
            await interaction.reply(
              `Nu există date pentru ${user}.`
            );

            return;
          }

          await interaction.reply(
            `👤 **Membru: ${user.username}**\n\n` +
            `🆔 ID: ${user.id}\n` +
            `📅 Joined: ${data.joined_at || "-"}\n` +
            `🎁 Bonus nou: ${data.new_member_bonus_start || "-"} → ${data.new_member_bonus_end || "-"}\n` +
            `👑 Team Leader: ${data.is_team_leader ? "DA" : "NU"}\n` +
            `👥 Team ID: ${data.team_id || "-"}\n` +
            `🏆 Bonus echipă: ${data.team_bonus_start || "-"} → ${data.team_bonus_end || "-"}`
          );

          return;
        }

        /* ADMIN TEAM */

        if (
          subcommand === "team"
        ) {
          const leader =
            interaction.options.getUser(
              "leader"
            );

          const { data, error } =
            await supabase
              .from("teams")
              .select("*")
              .eq(
                "leader_discord_id",
                leader.id
              )
              .order(
                "formed_at",
                {
                  ascending: false,
                }
              )
              .limit(1)
              .maybeSingle();

          if (error) {
            console.error(error);

            await interaction.reply(
              "❌ Eroare la citirea echipei."
            );

            return;
          }

          if (!data) {
            await interaction.reply(
              `Nu există echipă pentru ${leader}.`
            );

            return;
          }

          await interaction.reply(
            `👥 **Echipa #${data.id}**\n\n` +
            `👑 Leader: <@${data.leader_discord_id}>\n` +
            `1️⃣ <@${data.member_1}>\n` +
            `2️⃣ <@${data.member_2}>\n` +
            `3️⃣ <@${data.member_3}>\n` +
            `4️⃣ <@${data.member_4}>\n` +
            `5️⃣ <@${data.member_5}>\n\n` +
            `📅 Formată: ${data.formed_at}\n` +
            `🎁 Bonus: ${data.bonus_start || "-"} → ${data.bonus_end || "-"}`
          );

          return;
        }

        /* ADMIN MEMBERS */

        if (
          subcommand ===
          "members"
        ) {
          const now =
            new Date().toISOString();

          const { data, error } =
            await supabase
              .from("members")
              .select("*")
              .or(
                `new_member_bonus_end.gte.${now},team_bonus_end.gte.${now}`
              )
              .order(
                "joined_at",
                {
                  ascending: false,
                }
              );

          if (error) {
            console.error(error);

            await interaction.reply(
              "❌ Eroare la citirea membrilor."
            );

            return;
          }

          if (
            !data ||
            data.length === 0
          ) {
            await interaction.reply(
              "Nu există membri cu bonus activ."
            );

            return;
          }

          let text =
            "👥 **Membri activi**\n\n";

          for (
            const member of data
          ) {
            text +=
              `• <@${member.discord_id}>` +
              ` | Team Leader: ${
                member.is_team_leader
                  ? "DA"
                  : "NU"
              }` +
              ` | Team: ${
                member.team_id ||
                "-"
              }\n`;
          }

          await interaction.reply(
            text
          );

          return;
        }

        /* ADMIN TEAMS */

        if (
          subcommand ===
          "teams"
        ) {
          const { data, error } =
            await supabase
              .from("teams")
              .select("*")
              .order(
                "formed_at",
                {
                  ascending: false,
                }
              );

          if (error) {
            console.error(error);

            await interaction.reply(
              "❌ Eroare la citirea echipelor."
            );

            return;
          }

          if (
            !data ||
            data.length === 0
          ) {
            await interaction.reply(
              "Nu există echipe create."
            );

            return;
          }

          let text =
            "🏆 **Echipe NACE**\n\n";

          for (
            const team of data
          ) {
            text +=
              `**Echipa #${team.id}**\n` +
              `👑 <@${team.leader_discord_id}>\n` +
              `👥 <@${team.member_1}> <@${team.member_2}> <@${team.member_3}> <@${team.member_4}> <@${team.member_5}>\n` +
              `📅 ${team.formed_at}\n\n`;
          }

          await interaction.reply(
            text
          );

          return;
        }
      }
    } catch (error) {
      console.error(
        "Slash command error:",
        error
      );

      if (
        !interaction.replied
      ) {
        await interaction.reply({
          content:
            "❌ A apărut o eroare.",
          ephemeral: true,
        });
      }
    }
  }
);

/* =========================
   DM SCREENSHOT VERIFICATION
========================= */

client.on(
  "messageCreate",
  async message => {
    try {
      if (message.author.bot) {
        return;
      }

      if (
        !message.guild &&
        message.attachments.size > 0
      ) {
        const attachment =
          message.attachments.first();

        const result =
          await verifyScreenshot(
            attachment.url
          );

        if (result.approved) {
          try {
            const guild =
              await client.guilds.fetch(
                GUILD_ID
              );

            const member =
              await guild.members.fetch(
                message.author.id
              );

            const traderRole =
              guild.roles.cache.get(
                TRADER_ROLE_ID
              );

            if (traderRole) {
              await member.roles.add(
                traderRole
              );

              await message.reply(
                "✅ **Cont verificat cu succes!**\n\n" +
                "Ai primit rolul **Trader**. 🚀"
              );
            } else {
              await message.reply(
                "✅ Cont verificat, dar rolul Trader nu a fost găsit."
              );
            }
          } catch (roleError) {
            console.error(
              "Role assignment:",
              roleError
            );

            await message.reply(
              "❌ Contul a fost verificat, dar nu am putut acorda rolul Trader."
            );
          }
        } else {
          await message.reply(
            "❌ Screenshot-ul nu îndeplinește condițiile.\n\n" +
            "Trebuie să fie vizibile clar:\n" +
            "• Verified\n" +
            "• Found Account sau Trading Account\n" +
            "• suma de minimum 500"
          );
        }
      }
    } catch (error) {
      console.error(
        "Screenshot verification:",
        error
      );
    }
  }
);

/* =========================
   LOGIN
========================= */

client.login(
  DISCORD_TOKEN
);
