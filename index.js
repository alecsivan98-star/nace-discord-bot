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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const GUILD_ID = process.env.GUILD_ID;
const TRADER_ROLE_ID = process.env.TRADER_ROLE_ID;
const NACE_URL = process.env.NACE_URL || "https://nacetuin.com/";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const SIGNAL_TIMES = {
  normal1: { hour: 12, minute: 10 },
  newMember: { hour: 13, minute: 0 },
  teamLeader: { hour: 12, minute: 30 },
  normal2: { hour: 17, minute: 10 },
  normal3: { hour: 20, minute: 10 },
};

const NORMAL_SIGNAL_ROLES = [
  "Trader",
  "Team Leader",
  "Moderator",
  "Admin",
];

let signalChannelId = process.env.SIGNAL_CHANNEL_ID || null;

/* =========================
   SUPABASE
========================= */

async function saveMember(member) {
  const { error } = await supabase
    .from("members")
    .upsert(
      {
        discord_id: member.id,
        username: member.user.tag,
        joined_at: member.joinedAt || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "discord_id",
      }
    );

  if (error) {
    console.error("Supabase saveMember:", error.message);
  }
}

async function getMemberData(discordId) {
  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error) {
    console.error("Supabase getMemberData:", error.message);
    return null;
  }

  return data;
}

async function activateNewMemberBonus(member) {
  const existing = await getMemberData(member.id);

  if (existing?.new_member_bonus_start) {
    return;
  }

  const start = new Date();
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const { error } = await supabase
    .from("members")
    .upsert(
      {
        discord_id: member.id,
        username: member.user.tag,
        joined_at: member.joinedAt || start.toISOString(),
        new_member_bonus_start: start.toISOString(),
        new_member_bonus_end: end.toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "discord_id",
      }
    );

  if (error) {
    console.error("Supabase activateNewMemberBonus:", error.message);
  }
}

async function createTeamInDatabase(
  leaderId,
  memberIds
) {
  if (memberIds.length !== 5) {
    throw new Error("Echipa trebuie să aibă exact 5 membri.");
  }

  const formedAt = new Date();
  const bonusEnd = new Date(
    formedAt.getTime() + 20 * 24 * 60 * 60 * 1000
  );

  const { data, error } = await supabase
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

  if (error) {
    throw new Error(error.message);
  }

  const teamId = data.id;

  const { error: leaderError } = await supabase
    .from("members")
    .upsert(
      {
        discord_id: leaderId,
        is_team_leader: true,
        team_id: teamId,
        team_bonus_start: formedAt.toISOString(),
        team_bonus_end: bonusEnd.toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "discord_id",
      }
    );

  if (leaderError) {
    console.error("Supabase leader update:", leaderError.message);
  }

  return data;
}

/* =========================
   VERIFICARE SCREENSHOT
========================= */

async function verifyScreenshot(imageUrl) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
Analyze this screenshot for NACE account verification.

The screenshot can be APPROVED only if ALL of these requirements are satisfied:

1. A visible "Verified" status is present.
2. A visible account section is present:
   - "Found Account"
   - OR "Trading Account"
3. A numerical account/trading amount is visible.
4. The amount must be at least 500.
5. The screenshot must be reasonably clear.

Do not guess missing information.

Do not request or extract:
- passwords
- private keys
- seed phrases
- 2FA/recovery codes

Return ONLY JSON:

{
  "approved": true,
  "verified": true,
  "account_found": true,
  "amount": 2000,
  "reason": "Verified status, account section and amount >= 500 are visible."
}

If rejected:

{
  "approved": false,
  "verified": false,
  "account_found": false,
  "amount": 0,
  "reason": "Explain briefly which required condition is missing."
}
`,
          },
          {
            type: "input_image",
            image_url: imageUrl,
          },
        ],
      },
    ],
  });

  const text = response.output_text?.trim();

  if (!text) {
    throw new Error("AI nu a returnat un rezultat.");
  }

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const result = JSON.parse(cleaned);

  const amount = Number(result.amount);

  const approved =
    result.approved === true &&
    result.verified === true &&
    result.account_found === true &&
    Number.isFinite(amount) &&
    amount >= 500;

  return {
    approved,
    verified: result.verified === true,
    account_found: result.account_found === true,
    amount: Number.isFinite(amount) ? amount : 0,
    reason: result.reason || "Fără explicație.",
  };
}

async function giveTraderRole(member) {
  const role = await member.guild.roles.fetch(TRADER_ROLE_ID);

  if (!role) {
    throw new Error("Rolul Trader nu a fost găsit.");
  }

  if (!role.editable) {
    throw new Error(
      "Botul nu poate acorda rolul Trader. Verifică poziția rolului botului."
    );
  }

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role);
  }
}

/* =========================
   MENIURI
========================= */

function mainMenu() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("nace_register")
      .setLabel("🚀 Înregistrare NACE")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("nace_funding")
      .setLabel("💰 Alimentare cont")
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("nace_copy")
      .setLabel("📈 Copy Trading")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("nace_verify")
      .setLabel("📸 Verificare cont")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: "👇 **Alege ce vrei să faci:**",
    components: [row1, row2],
  };
}

function registrationTutorial() {
  return {
    content:
      `🚀 **TUTORIAL COMPLET — ÎNREGISTRARE NACE**\n\n` +
      `**1️⃣ Intră pe NACE**\n${NACE_URL}\n\n` +
      `**2️⃣ Creează contul**\n` +
      `Apasă pe opțiunea de înregistrare și completează datele solicitate.\n\n` +
      `**3️⃣ Confirmă contul**\n` +
      `Urmează pașii afișați de platformă.\n\n` +
      `**4️⃣ Intră în cont**\n` +
      `După înregistrare, conectează-te în contul NACE.\n\n` +
      `**5️⃣ Verificarea identității**\n` +
      `Dacă platforma solicită KYC, urmează pașii afișați direct în NACE.\n\n` +
      `🔐 Nu trimite parola, codurile 2FA, seed phrase sau cheia privată.\n\n` +
      `**6️⃣ Intră în zona de trading**\n` +
      `Verifică zona de trading disponibilă în cont.\n\n` +
      `**7️⃣ Alimentează contul**\n` +
      `Apasă pe **💰 Alimentare cont** pentru tutorialele OKX, Binance și Bitget.\n\n` +
      `**8️⃣ Verifică depunerea**\n` +
      `Confirmă că fondurile au ajuns în cont.\n\n` +
      `**9️⃣ Ultimul pas**\n` +
      `Trimite screenshot-ul aici în DM pentru verificare.`
  };
}

function fundingMenu() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("fund_okx")
      .setLabel("🟢 OKX")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("fund_binance")
      .setLabel("🟡 Binance")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("fund_bitget")
      .setLabel("🔵 Bitget")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    content:
      `💰 **ALIMENTARE CONT NACE**\n\n` +
      `Alege platforma de pe care vrei să trimiți crypto către NACE.\n\n` +
      `⚠️ Verifică întotdeauna moneda, adresa și rețeaua afișate în NACE.`,
    components: [row],
  };
}

function okxTutorial() {
  return {
    content:
      `🟢 **TUTORIAL OKX → NACE**\n\n` +
      `**1️⃣** Intră în OKX și deschide zona de retragere.\n\n` +
      `**2️⃣** Alege moneda disponibilă pentru depunerea în NACE.\n\n` +
      `**3️⃣** În NACE intră la Deposit și copiază adresa.\n\n` +
      `**4️⃣** Selectează exact aceeași rețea în OKX.\n\n` +
      `**5️⃣** Verifică moneda, adresa, rețeaua și suma.\n\n` +
      `**6️⃣** Confirmă retragerea.\n\n` +
      `⚠️ Nu folosi adrese sau rețele primite de la alte persoane.`
  };
}

function binanceTutorial() {
  return {
    content:
      `🟡 **TUTORIAL BINANCE → NACE**\n\n` +
      `**1️⃣** Intră la Withdraw / Retragere.\n\n` +
      `**2️⃣** Alege moneda.\n\n` +
      `**3️⃣** În NACE intră la Deposit și copiază adresa.\n\n` +
      `**4️⃣** Selectează aceeași rețea afișată de NACE.\n\n` +
      `**5️⃣** Verifică adresa, moneda, rețeaua și suma.\n\n` +
      `**6️⃣** Confirmă transferul.\n\n` +
      `⚠️ O rețea greșită poate duce la pierderea fondurilor.`
  };
}

function bitgetTutorial() {
  return {
    content:
      `🔵 **TUTORIAL BITGET → NACE**\n\n` +
      `**1️⃣** Intră la Withdraw.\n\n` +
      `**2️⃣** Alege moneda.\n\n` +
      `**3️⃣** În NACE deschide Deposit și copiază adresa.\n\n` +
      `**4️⃣** Selectează aceeași rețea.\n\n` +
      `**5️⃣** Verifică toate datele.\n\n` +
      `**6️⃣** Confirmă transferul.\n\n` +
      `⚠️ Nu trimite fondurile până nu verifici moneda, adresa și rețeaua.`
  };
}

function copyTradingTutorial() {
  return {
    content:
      `📈 **TUTORIAL COPY TRADING NACE**\n\n` +
      `**1️⃣** Intră în Copy Trading.\n\n` +
      `**2️⃣** Analizează traderii disponibili.\n\n` +
      `**3️⃣** Verifică performanța, drawdown-ul și istoricul.\n\n` +
      `**4️⃣** Alege traderul.\n\n` +
      `**5️⃣** Configurează suma și parametrii.\n\n` +
      `**6️⃣** Activează Copy Trading.\n\n` +
      `**7️⃣** Monitorizează rezultatele.\n\n` +
      `⚠️ Copy Trading nu garantează profit și implică risc de pierdere.`
  };
}

function verificationTutorial() {
  return {
    content:
      `📸 **VERIFICAREA CONTULUI NACE**\n\n` +
      `Pentru aprobare trebuie să fie vizibile clar:\n\n` +
      `☑️ **Verified**\n` +
      `☑️ **Found Account** sau **Trading Account**\n` +
      `☑️ Sumă de minimum **500**\n\n` +
      `Dacă toate condițiile sunt îndeplinite, botul acordă automat rolul **Trader**.\n\n` +
      `🔐 Nu trimite parole, seed phrase, chei private sau coduri 2FA.`
  };
}

/* =========================
   SEMNALE
========================= */

function getRomaniaTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
}

function currentRomaniaHourMinute() {
  const parts = getRomaniaTime();

  const hour = Number(
    parts.find((p) => p.type === "hour")?.value
  );

  const minute = Number(
    parts.find((p) => p.type === "minute")?.value
  );

  return { hour, minute };
}

function signalMessage(type) {
  if (type === "normal1") {
    return (
      `🚨 **NACE SIGNAL #1** 🚨\n\n` +
      `🔥 **PRIMUL SEMNAL AL ZILEI ESTE LIVE!**\n\n` +
      `📊 Verifică semnalul și pregătește-te.\n\n` +
      `⚡ **NACE TEAM**`
    );
  }

  if (type === "normal2") {
    return (
      `🚨 **NACE SIGNAL #2** 🚨\n\n` +
      `🔥 **AL DOILEA SEMNAL AL ZILEI ESTE LIVE!**\n\n` +
      `📊 Verifică semnalul și pregătește-te.\n\n` +
      `⚡ **NACE TEAM**`
    );
  }

  if (type === "normal3") {
    return (
      `🚨 **NACE SIGNAL #3** 🚨\n\n` +
      `🔥 **AL TREILEA SEMNAL AL ZILEI ESTE LIVE!**\n\n` +
      `📊 Verifică semnalul și pregătește-te.\n\n` +
      `⚡ **NACE TEAM**`
    );
  }

  if (type === "newMember") {
    return (
      `🆕 **NACE NEW MEMBER BONUS** 🆕\n\n` +
      `🔥 **SEMNALUL BONUS DE LA 13:00 ESTE LIVE!**\n\n` +
      `Acest semnal este disponibil membrilor aflați în primele 3 zile.\n\n` +
      `⚡ **NACE TEAM**`
    );
  }

  if (type === "teamLeader") {
    return (
      `👑 **NACE TEAM LEADER BONUS** 👑\n\n` +
      `🔥 **SEMNALUL BONUS DE LA 12:30 ESTE LIVE!**\n\n` +
      `Acest bonus este disponibil Team Leaderilor eligibili.\n\n` +
      `⚡ **NACE TEAM**`
    );
  }

  return "🚨 **NACE SIGNAL LIVE!**";
}

async function getSignalChannel() {
  if (!signalChannelId) {
    return null;
  }

  const channel = await client.channels
    .fetch(signalChannelId)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) {
    return null;
  }

  return channel;
}

async function sendNormalSignal(type) {
  const channel = await getSignalChannel();

  if (!channel) {
    console.log(
      `Semnal ${type}: SIGNAL_CHANNEL_ID nu este configurat.`
    );
    return;
  }

  const guild = await client.guilds.fetch(GUILD_ID);

  const roleMentions = [];

  for (const roleName of NORMAL_SIGNAL_ROLES) {
    const role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === roleName.toLowerCase()
    );

    if (role) {
      roleMentions.push(`<@&${role.id}>`);
    }
  }

  const content =
    roleMentions.join(" ") +
    "\n\n" +
    signalMessage(type);

  const sent = await channel.send({
    content,
    allowedMentions: {
      roles: roleMentions.map((mention) =>
        mention.replace(/[<@&>]/g, "")
      ),
    },
  });

  await logSignal(type, channel.id, sent.id);
}

async function sendEligibleNewMemberSignal() {
  const channel = await getSignalChannel();

  if (!channel) {
    console.log(
      "Semnal 13:00: SIGNAL_CHANNEL_ID nu este configurat."
    );
    return;
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("members")
    .select("discord_id")
    .lte("new_member_bonus_start", now)
    .gte("new_member_bonus_end", now);

  if (error) {
    console.error(
      "Eroare membri bonus 13:00:",
      error.message
    );
    return;
  }

  if (!data || data.length === 0) {
    return;
  }

  const mentions = data.map(
    (member) => `<@${member.discord_id}>`
  );

  const sent = await channel.send({
    content:
      mentions.join(" ") +
      "\n\n" +
      signalMessage("newMember"),
    allowedMentions: {
      users: data.map((member) => member.discord_id),
    },
  });

  await logSignal("newMember", channel.id, sent.id);
}

async function sendEligibleTeamLeaderSignal() {
  const channel = await getSignalChannel();

  if (!channel) {
    console.log(
      "Semnal 12:30: SIGNAL_CHANNEL_ID nu este configurat."
    );
    return;
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("members")
    .select("discord_id")
    .eq("is_team_leader", true)
    .lte("team_bonus_start", now)
    .gte("team_bonus_end", now);

  if (error) {
    console.error(
      "Eroare Team Leader bonus:",
      error.message
    );
    return;
  }

  if (!data || data.length === 0) {
    return;
  }

  const mentions = data.map(
    (member) => `<@${member.discord_id}>`
  );

  const sent = await channel.send({
    content:
      mentions.join(" ") +
      "\n\n" +
      signalMessage("teamLeader"),
    allowedMentions: {
      users: data.map((member) => member.discord_id),
    },
  });

  await logSignal("teamLeader", channel.id, sent.id);
}

async function logSignal(type, channelId, messageId) {
  const { error } = await supabase
    .from("signal_logs")
    .insert({
      signal_type: type,
      signal_time: new Date().toISOString(),
      discord_channel_id: channelId,
      message_id: messageId,
    });

  if (error) {
    console.error("Signal log error:", error.message);
  }
}

let lastSignalKey = null;

async function checkSignals() {
  const { hour, minute } = currentRomaniaHourMinute();

  const key = `${new Date().toISOString().slice(0, 10)}-${hour}-${minute}`;

  if (key === lastSignalKey) {
    return;
  }

  if (
    hour === SIGNAL_TIMES.normal1.hour &&
    minute === SIGNAL_TIMES.normal1.minute
  ) {
    lastSignalKey = key;
    await sendNormalSignal("normal1");
  }

  if (
    hour === SIGNAL_TIMES.teamLeader.hour &&
    minute === SIGNAL_TIMES.teamLeader.minute
  ) {
    lastSignalKey = key;
    await sendEligibleTeamLeaderSignal();
  }

  if (
    hour === SIGNAL_TIMES.newMember.hour &&
    minute === SIGNAL_TIMES.newMember.minute
  ) {
    lastSignalKey = key;
    await sendEligibleNewMemberSignal();
  }

  if (
    hour === SIGNAL_TIMES.normal2.hour &&
    minute === SIGNAL_TIMES.normal2.minute
  ) {
    lastSignalKey = key;
    await sendNormalSignal("normal2");
  }

  if (
    hour === SIGNAL_TIMES.normal3.hour &&
    minute === SIGNAL_TIMES.normal3.minute
  ) {
    lastSignalKey = key;
    await sendNormalSignal("normal3");
  }
}

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Vezi statusul tău NACE"),

  new SlashCommandBuilder()
    .setName("team")
    .setDescription("Gestionează o echipă")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Formează o echipă de 5 membri")
        .addUserOption((option) =>
          option
            .setName("member1")
            .setDescription("Membru 1")
            .setRequired(true)
        )
        .addUserOption((option) =>
          option
            .setName("member2")
            .setDescription("Membru 2")
            .setRequired(true)
        )
        .addUserOption((option) =>
          option
            .setName("member3")
            .setDescription("Membru 3")
            .setRequired(true)
        )
        .addUserOption((option) =>
          option
            .setName("member4")
            .setDescription("Membru 4")
            .setRequired(true)
        )
        .addUserOption((option) =>
          option
            .setName("member5")
            .setDescription("Membru 5")
            .setRequired(true)
        )
    ),

   new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Comenzi administrative")
    .addSubcommand(sub =>
      sub
        .setName("member")
        .setDescription("Vezi informațiile unui membru")
        .addUserOption(option =>
          option
            .setName("user")
            .setDescription("Membrul")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("team")
        .setDescription("Vezi informațiile unei echipe")
        .addUserOption(option =>
          option
            .setName("leader")
            .setDescription("Team Leader")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("members")
        .setDescription("Vezi membrii activi")
    )
    .addSubcommand(sub =>
      sub
        .setName("teams")
        .setDescription("Vezi echipele")
    ),
];

async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        GUILD_ID
      ),
      {
        body: commands.map(command => command.toJSON()),
      }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Error registering slash commands:", error);
  }
}

/* =========================
   BOT READY
========================= */

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();

  console.log("NACE Assistant is online.");

  checkSignals();
  setInterval(checkSignals, 30000);
});

/* =========================
   MEMBER JOIN
========================= */

client.on("guildMemberAdd", async member => {
  try {
    await saveMember(member);

    await activateNewMemberBonus(member.id);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("register_nace")
        .setLabel("🚀 Înregistrare NACE")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("funding")
        .setLabel("💰 Alimentare cont")
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId("copy_trading")
        .setLabel("📈 Copy Trading")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("verify_account")
        .setLabel("📸 Verificare cont")
        .setStyle(ButtonStyle.Primary)
    );

    await member.send({
      content:
        `👋 Salut ${member.user.username}!\n\n` +
        `Bine ai venit în **NACE**.\n\n` +
        `Folosește butoanele de mai jos pentru a începe.`,
      components: [row],
    });

    console.log(`New member joined: ${member.user.tag}`);
  } catch (error) {
    console.error("guildMemberAdd error:", error);
  }
});

/* =========================
   BUTTON INTERACTIONS
========================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.customId === "register_nace") {
      await interaction.reply({
        content:
          `🚀 **Înregistrare NACE**\n\n` +
          `Intră pe:\n${NACE_URL}\n\n` +
          `După înregistrare, revino aici pentru verificare.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId === "funding") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fund_okx")
          .setLabel("OKX")
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId("fund_binance")
          .setLabel("Binance")
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId("fund_bitget")
          .setLabel("Bitget")
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({
        content: "💰 Alege platforma:",
        components: [row],
        ephemeral: true,
      });
      return;
    }

    if (
      interaction.customId === "fund_okx" ||
      interaction.customId === "fund_binance" ||
      interaction.customId === "fund_bitget"
    ) {
      await interaction.reply({
        content:
          "💰 După ce ai alimentat contul, trimite aici screenshot-ul pentru verificare.\n\n" +
          "Screenshot-ul trebuie să arate clar:\n" +
          "• Verified\n" +
          "• Found Account sau Trading Account\n" +
          "• suma de minimum 500",
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId === "copy_trading") {
      await interaction.reply({
        content:
          "📈 **Copy Trading**\n\n" +
          "Pentru informații despre Copy Trading, contactează echipa NACE.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId === "verify_account") {
      await interaction.reply({
        content:
          "📸 Trimite-mi în acest DM screenshot-ul contului tău.\n\n" +
          "Trebuie să fie vizibile:\n" +
          "• Verified\n" +
          "• Found Account sau Trading Account\n" +
          "• o sumă de minimum 500",
        ephemeral: true,
      });
      return;
    }
  } catch (error) {
    console.error("Button interaction error:", error);

    if (!interaction.replied) {
      await interaction.reply({
        content: "A apărut o eroare. Încearcă din nou.",
        ephemeral: true,
      });
    }
  }
});

/* =========================
   SLASH COMMAND INTERACTIONS
========================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    /* =========================
       STATUS
    ========================= */

    if (interaction.commandName === "status") {
      const data = await getMemberData(interaction.user.id);

      if (!data) {
        await interaction.reply("Nu există date pentru contul tău.");
        return;
      }

      const now = new Date();

      const newBonusActive =
        data.new_member_bonus_end &&
        new Date(data.new_member_bonus_end) > now;

      const teamBonusActive =
        data.team_bonus_end &&
        new Date(data.team_bonus_end) > now;

      await interaction.reply(
        `📊 **Status NACE – ${interaction.user.username}**\n\n` +
        `🎁 Bonus membru nou: ${
          newBonusActive ? "ACTIV" : "INACTIV"
        }\n` +
        `👥 Team Leader: ${
          data.is_team_leader ? "DA" : "NU"
        }\n` +
        `🏆 Bonus Team Leader: ${
          teamBonusActive ? "ACTIV" : "INACTIV"
        }`
      );

      return;
    }

    /* =========================
       TEAM
    ========================= */

    if (
      interaction.commandName === "team" &&
      interaction.options.getSubcommand() === "create"
    ) {
      if (
        !interaction.member.permissions.has(
          PermissionsBitField.Flags.ManageGuild
        )
      ) {
        await interaction.reply({
          content: "Nu ai permisiunea necesară.",
          ephemeral: true,
        });
        return;
      }

      const members = [];

      for (let i = 1; i <= 5; i++) {
        const user = interaction.options.getUser(`member${i}`);
        members.push(user);
      }

      const ids = members.map(user => user.id);

      if (new Set(ids).size !== 5) {
        await interaction.reply({
          content: "Nu poți introduce același membru de mai multe ori.",
          ephemeral: true,
        });
        return;
      }

      const leader = members[0];

      const result = await createTeamInDatabase(
        leader.id,
        ids
      );

      if (!result.success) {
        await interaction.reply({
          content: `❌ ${result.error}`,
          ephemeral: true,
        });
        return;
      }

      const leaderMember = await interaction.guild.members.fetch(
        leader.id
      );

      const teamLeaderRole =
        interaction.guild.roles.cache.find(
          role => role.name === "Team Leader"
        );

      if (teamLeaderRole) {
        await leaderMember.roles.add(teamLeaderRole);
      }

      await interaction.reply(
        `✅ **Echipa a fost creată!**\n\n` +
        `👑 Team Leader: ${leader}\n` +
        `👥 Membri: ${members.slice(1).join(", ")}\n\n` +
        `🎁 Bonus Team Leader activ timp de **20 de zile**.\n` +
        `⏰ Semnal bonus zilnic la **12:30**.`
      );

      return;
    }

    /* =========================
       ADMIN
    ========================= */

    if (interaction.commandName === "admin") {
      if (
        !interaction.member.permissions.has(
          PermissionsBitField.Flags.Administrator
        )
      ) {
        await interaction.reply({
          content: "❌ Nu ai permisiune de Administrator.",
          ephemeral: true,
        });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      /* ADMIN MEMBER */

      if (subcommand === "member") {
        const user = interaction.options.getUser("user");

        const data = await getMemberData(user.id);

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

      if (subcommand === "team") {
        const leader = interaction.options.getUser("leader");

        const { data, error } = await supabase
          .from("teams")
          .select("*")
          .eq("leader_discord_id", leader.id)
          .order("formed_at", { ascending: false })
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

      if (subcommand === "members") {
        const now = new Date().toISOString();

        const { data, error } = await supabase
          .from("members")
          .select("*")
          .or(
            `new_member_bonus_end.gte.${now},team_bonus_end.gte.${now}`
          )
          .order("joined_at", { ascending: false });

        if (error) {
          console.error(error);

          await interaction.reply(
            "❌ Eroare la citirea membrilor."
          );

          return;
        }

        if (!data || data.length === 0) {
          await interaction.reply(
            "Nu există membri cu bonus activ."
          );
          return;
        }

        let text = "👥 **Membri activi**\n\n";

        for (const member of data) {
          text +=
            `• <@${member.discord_id}>` +
            ` | Team Leader: ${member.is_team_leader ? "DA" : "NU"}` +
            ` | Team: ${member.team_id || "-"}\n`;
        }

        await interaction.reply(text);

        return;
      }

      /* ADMIN TEAMS */

      if (subcommand === "teams") {
        const { data, error } = await supabase
          .from("teams")
          .select("*")
          .order("formed_at", { ascending: false });

        if (error) {
          console.error(error);

          await interaction.reply(
            "❌ Eroare la citirea echipelor."
          );

          return;
        }

        if (!data || data.length === 0) {
          await interaction.reply(
            "Nu există echipe create."
          );
          return;
        }

        let text = "🏆 **Echipe NACE**\n\n";

        for (const team of data) {
          text +=
            `**Echipa #${team.id}**\n` +
            `👑 <@${team.leader_discord_id}>\n` +
            `👥 <@${team.member_1}> <@${team.member_2}> <@${team.member_3}> <@${team.member_4}> <@${team.member_5}>\n` +
            `📅 ${team.formed_at}\n\n`;
        }

        await interaction.reply(text);

        return;
      }
    }
  } catch (error) {
    console.error("Slash command error:", error);

    if (!interaction.replied) {
      await interaction.reply({
        content: "❌ A apărut o eroare.",
        ephemeral: true,
      });
    }
  }
});

/* =========================
   SCREENSHOT VERIFICATION
========================= */

client.on("messageCreate", async message => {
  try {
    if (message.author.bot) return;

    if (!message.guild && message.attachments.size > 0) {
      const attachment = message.attachments.first();

      const result = await verifyScreenshot(
        attachment.url
      );

      if (result.approved) {
        try {
          const guild = await client.guilds.fetch(GUILD_ID);
          const member = await guild.members.fetch(
            message.author.id
          );

          const traderRole =
            guild.roles.cache.get(TRADER_ROLE_ID);

          if (traderRole) {
            await member.roles.add(traderRole);
          }

          await message.reply(
            "✅ **Cont verificat cu succes!**\n\n" +
            "Ai primit rolul **Trader**."
          );

          console.log(
            `Verified member: ${message.author.tag}`
          );
        } catch (roleError) {
          console.error(
            "Role assignment error:",
            roleError
          );

          await message.reply(
            "Contul a fost verificat, dar nu am putut acorda rolul Trader."
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
      "Screenshot verification error:",
      error
    );
  }
});

/* =========================
   LOGIN
========================= */

client.login(DISCORD_TOKEN);
