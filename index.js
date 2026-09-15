require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

/* =========================================================
   CONFIG
========================================================= */

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
  console.error("❌ Lipseste DISCORD_TOKEN");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("❌ Lipseste GUILD_ID");
  process.exit(1);
}

if (!TRADER_ROLE_ID) {
  console.error("❌ Lipseste TRADER_ROLE_ID");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Lipsesc SUPABASE_URL sau SUPABASE_KEY");
  process.exit(1);
}

/* =========================================================
   CLIENT
========================================================= */

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
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* =========================================================
   CONSTANTE
========================================================= */

const NORMAL_SIGNAL_ROLES = [
  "Trader",
  "Team Leader",
  "Moderator",
  "Admin",
];

const SIGNAL_TIMES = {
  signal_1: "12:10",
  team_leader: "12:30",
  new_member: "13:00",
  signal_2: "17:10",
  signal_3: "20:10",
};

let lastSignalKey = "";

/* =========================================================
   UTILS
========================================================= */

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionsBitField.Flags.Administrator
  );
}

function truncate(text, max = 1900) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function chunkText(text, max = 1900) {
  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > max) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += current ? "\n" + line : line;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

/* =========================================================
   SUPABASE - MEMBERS
========================================================= */

async function saveMember(member) {
  const { error } = await supabase
    .from("members")
    .upsert(
      {
        discord_id: member.id,
        username: member.user.username,
        updated_at: new Date().toISOString(),
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

/* =========================================================
   SUPABASE - TEAMS
========================================================= */

async function createTeamInDatabase(leaderId, memberIds) {
  if (memberIds.length !== 5) {
    return {
      success: false,
      error: "O echipă trebuie să aibă exact 5 membri.",
    };
  }

  const uniqueIds = [...new Set(memberIds)];

  if (uniqueIds.length !== 5) {
    return {
      success: false,
      error: "Toți cei 5 membri trebuie să fie diferiți.",
    };
  }

  if (!uniqueIds.includes(leaderId)) {
    return {
      success: false,
      error: "Team Leader-ul trebuie să fie unul dintre cei 5 membri.",
    };
  }

  const formedAt = new Date();

  const bonusEnd = new Date(
    formedAt.getTime() + 20 * 24 * 60 * 60 * 1000
  );

  const { data: team, error: teamError } = await supabase
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

    const { error } = await supabase
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

    if (error) {
      console.error("team member update:", error);
    }
  }

  return {
    success: true,
    team,
  };
}

/* =========================================================
   SCREENSHOT VERIFICATION
========================================================= */

async function verifyScreenshot(imageUrl) {
  if (!openai) {
    return {
      approved: false,
      verified: false,
      account_found: false,
      amount: 0,
      reason: "OPENAI_API_KEY nu este configurat.",
    };
  }

  try {
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

The screenshot can be APPROVED only if ALL requirements are satisfied:

1. A visible "Verified" status is present.
- It must clearly indicate that the account/user is verified.
- If "Verified" is missing or unclear, reject.

2. A visible account section is present.

Accept either:
- "Found Account"
- "Trading Account"

The wording must be reasonably clear.

3. A numerical account/trading amount is visible.
- The amount must be at least 500.
- Do NOT require exact amounts such as 500, 1000, 2000 or 3000.
- Values between and around these amounts are acceptable.
- Examples acceptable: 500, 520, 750, 980, 1050, 1500, 1980, 2100, 2900, 3050.
- Any amount below 500 must be rejected.
- Do not guess an unreadable amount.

4. The screenshot must provide reasonably clear visual evidence.
- Reject unrelated images.
- Reject if required information cannot be read reliably.
- Do not guess missing information.

IMPORTANT:
- Never request passwords.
- Never request private keys.
- Never request seed phrases.
- Never request 2FA codes.
- Never request recovery codes.
- Only evaluate information visibly present in the screenshot.

Return ONLY valid JSON:

{
  "approved": true,
  "verified": true,
  "account_found": true,
  "amount": 2000,
  "reason": "Verified status, account section and amount >= 500 are visible."
}

OR:

{
  "approved": false,
  "verified": false,
  "account_found": false,
  "amount": 0,
  "reason": "Explain briefly which required condition is missing."
}

The amount field must contain the numeric amount actually visible in the screenshot.
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
  } catch (error) {
    console.error("verifyScreenshot:", error);

    return {
      approved: false,
      verified: false,
      account_found: false,
      amount: 0,
      reason: "Nu am putut analiza screenshot-ul.",
    };
  }
}

/* =========================================================
   TIME ROMANIA
========================================================= */

function getRomaniaTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
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

/* =========================================================
   SIGNAL MESSAGES
========================================================= */

function signalMessage(type) {
  if (type === "signal_1") {
    return `
🚨 **NACE SIGNAL — 12:10**

Primul semnal al zilei este disponibil.

📌 Verifică informațiile și respectă întotdeauna propria strategie și gestionarea riscului.

⚠️ Semnalele nu reprezintă o garanție de profit.
`;
  }

  if (type === "signal_2") {
    return `
🚨 **NACE SIGNAL — 17:10**

Al doilea semnal al zilei este disponibil.

📌 Analizează informațiile înainte de orice acțiune și folosește o gestionare responsabilă a riscului.

⚠️ Niciun rezultat nu este garantat.
`;
  }

  if (type === "signal_3") {
    return `
🚨 **NACE SIGNAL — 20:10**

Al treilea semnal al zilei este disponibil.

📌 Verifică semnalul și ia decizii în funcție de propria strategie și toleranță la risc.

⚠️ Trading-ul implică riscuri.
`;
  }

  if (type === "new_member") {
    return `
🎁 **NACE BONUS SIGNAL — 13:00**

Acesta este semnalul bonus destinat membrilor noi eligibili.

⏳ Bonusul pentru membru nou este activ timp de **3 zile** de la activare.
`;
  }

  if (type === "team_leader") {
    return `
👑 **NACE TEAM LEADER SIGNAL — 12:30**

Acesta este semnalul bonus destinat Team Leaderilor eligibili.

⏳ Bonusul Team Leader este activ timp de **20 de zile** după formarea unei echipe complete de 5 membri.
`;
  }

  return "📢 NACE SIGNAL";
}

/* =========================================================
   SIGNAL LOG
========================================================= */

async function logSignal(type, channelId, messageId) {
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

/* =========================================================
   NORMAL SIGNALS
========================================================= */

async function sendNormalSignal(type) {
  if (!SIGNAL_CHANNEL_ID) {
    console.log("SIGNAL_CHANNEL_ID nu este configurat.");
    return;
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    const channel = await guild.channels.fetch(
      SIGNAL_CHANNEL_ID
    );

    if (!channel) return;

    const roleIds = [];

    for (const roleName of NORMAL_SIGNAL_ROLES) {
      const role = guild.roles.cache.find(
        (r) => r.name === roleName
      );

      if (role) {
        roleIds.push(role.id);
      }
    }

    const mentions = roleIds.map(
      (id) => `<@&${id}>`
    );

    const content =
      mentions.join(" ") +
      "\n\n" +
      signalMessage(type);

    const message = await channel.send({
      content,
      allowedMentions: {
        roles: roleIds,
      },
    });

    await logSignal(
      type,
      channel.id,
      message.id
    );

    console.log(`✅ Signal trimis: ${type}`);
  } catch (error) {
    console.error("sendNormalSignal:", error);
  }
}

/* =========================================================
   NEW MEMBER SIGNAL
========================================================= */

async function sendEligibleNewMemberSignal() {
  if (!SIGNAL_CHANNEL_ID) return;

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("members")
    .select("*")
    .lte("new_member_bonus_start", now)
    .gte("new_member_bonus_end", now);

  if (error) {
    console.error(
      "sendEligibleNewMemberSignal:",
      error
    );
    return;
  }

  if (!data || data.length === 0) {
    console.log("Nu există membri noi eligibili.");
    return;
  }

  try {
    const guild = await client.guilds.fetch(
      GUILD_ID
    );

    const channel = await guild.channels.fetch(
      SIGNAL_CHANNEL_ID
    );

    if (!channel) return;

    const userIds = data.map(
      (member) => member.discord_id
    );

    const mentions = userIds.map(
      (id) => `<@${id}>`
    );

    const message = await channel.send({
      content:
        mentions.join(" ") +
        "\n\n" +
        signalMessage("new_member"),

      allowedMentions: {
        users: userIds,
      },
    });

    await logSignal(
      "new_member",
      channel.id,
      message.id
    );

    console.log(
      `🎁 Bonus signal trimis către ${data.length} membri.`
    );
  } catch (error) {
    console.error(
      "sendEligibleNewMemberSignal:",
      error
    );
  }
}

/* =========================================================
   TEAM LEADER SIGNAL
========================================================= */

async function sendEligibleTeamLeaderSignal() {
  if (!SIGNAL_CHANNEL_ID) return;

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("is_team_leader", true)
    .lte("team_bonus_start", now)
    .gte("team_bonus_end", now);

  if (error) {
    console.error(
      "sendEligibleTeamLeaderSignal:",
      error
    );
    return;
  }

  if (!data || data.length === 0) {
    console.log("Nu există Team Leaderi eligibili.");
    return;
  }

  try {
    const guild = await client.guilds.fetch(
      GUILD_ID
    );

    const channel = await guild.channels.fetch(
      SIGNAL_CHANNEL_ID
    );

    if (!channel) return;

    const userIds = data.map(
      (member) => member.discord_id
    );

    const mentions = userIds.map(
      (id) => `<@${id}>`
    );

    const message = await channel.send({
      content:
        mentions.join(" ") +
        "\n\n" +
        signalMessage("team_leader"),

      allowedMentions: {
        users: userIds,
      },
    });

    await logSignal(
      "team_leader",
      channel.id,
      message.id
    );

    console.log(
      `👑 Team Leader signal trimis către ${data.length} membri.`
    );
  } catch (error) {
    console.error(
      "sendEligibleTeamLeaderSignal:",
      error
    );
  }
}

/* =========================================================
   CHECK SIGNALS
========================================================= */

async function checkSignals() {
  try {
    const time = currentRomaniaHourMinute();

    const key =
      `${time.date}-${time.hour}:${time.minute}`;

    if (key === lastSignalKey) {
      return;
    }

    if (
      time.hour === "12" &&
      time.minute === "10"
    ) {
      await sendNormalSignal("signal_1");
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

    if (
      time.hour === "13" &&
      time.minute === "00"
    ) {
      await sendEligibleNewMemberSignal();
      lastSignalKey = key;
      return;
    }

    if (
      time.hour === "17" &&
      time.minute === "10"
    ) {
      await sendNormalSignal("signal_2");
      lastSignalKey = key;
      return;
    }

    if (
      time.hour === "20" &&
      time.minute === "10"
    ) {
      await sendNormalSignal("signal_3");
      lastSignalKey = key;
      return;
    }
  } catch (error) {
    console.error("checkSignals:", error);
  }
}

/* =========================================================
   TUTORIAL - MAIN MENU
========================================================= */

function tutorialButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("register_nace")
      .setLabel("🚀 Înregistrare NACE")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("funding")
      .setLabel("💰 Alimentare cont")
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("copy_trading")
      .setLabel("📈 Copy Trading")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("verify_account")
      .setLabel("📸 Verificare")
      .setStyle(ButtonStyle.Primary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("signals_info")
      .setLabel("🚨 Semnale & Bonusuri")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("help_nace")
      .setLabel("❓ Ajutor")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2, row3];
}

/* =========================================================
   REGISTRATION TUTORIAL
========================================================= */

function registrationTutorial() {
  return `
🚀 **TUTORIAL COMPLET — ÎNREGISTRARE NACE**

Bun venit! Dacă ești la început, urmează pașii de mai jos în ordine.

### 1️⃣ Deschide pagina NACE

Accesează:

${NACE_URL}

Folosește pagina oficială furnizată de comunitatea NACE.

### 2️⃣ Începe procesul de înregistrare

Caută opțiunea de **Register / Sign Up / Create Account**, în funcție de interfața disponibilă.

Completează numai informațiile solicitate oficial de platformă.

### 3️⃣ Creează contul

Urmează pașii afișați de platformă pentru crearea contului.

Folosește o parolă puternică și unică.

⚠️ **Nu trimite nimănui parola ta.**

⚠️ **Nu trimite seed phrase, private key sau coduri 2FA.**

Botul NACE Assistant nu îți va cere niciodată aceste date.

### 4️⃣ Confirmarea contului

Dacă platforma îți cere confirmarea emailului sau alte verificări standard, urmează pașii afișați direct în platformă.

### 5️⃣ Verificarea identității

Dacă NACE îți solicită verificarea identității/KYC, urmează procesul oficial afișat de platformă.

📌 Botul nostru nu colectează documentele tale de identitate și nu îți cere să le trimiți în Discord.

### 6️⃣ După înregistrare

După ce ai terminat procesul disponibil pentru contul tău, poți trece la următorii pași:

➡️ Alimentarea contului  
➡️ Configurarea Copy Trading  
➡️ Verificarea contului în comunitate

### 7️⃣ Ce trebuie pentru verificarea Discord

Pentru verificarea rolului Trader, botul analizează doar informația vizibilă în screenshot.

Trebuie să fie vizibile clar:

✅ **Verified**

și

✅ **Found Account** sau **Trading Account**

și

✅ o sumă numerică de minimum **500**

Nu trebuie să fie exact 500, 1000, 2000 sau 3000.

Exemple:

500  
520  
750  
980  
1050  
1500  
1980  
2100  
2900  
3050

Orice valoare sub 500 este respinsă.

📸 Trimite screenshot-ul doar după ce informațiile necesare sunt vizibile clar.

⚠️ Nu include parole, seed phrase, private keys, coduri 2FA sau recovery codes în screenshot.
`;
}

/* =========================================================
   FUNDING MAIN
========================================================= */

function fundingPlatformButtons() {
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

  return [row];
}

/* =========================================================
   OKX TUTORIAL
========================================================= */

function okxTutorial() {
  return `
💰 **TUTORIAL ALIMENTARE — OKX**

Dacă folosești OKX pentru a alimenta contul, urmează pașii de mai jos.

### 1️⃣ Intră în OKX

Deschide aplicația sau site-ul OKX și conectează-te la contul tău.

### 2️⃣ Intră în zona Assets / Wallet

Caută secțiunea:

**Assets / Wallet**

Acolo vei găsi opțiunile disponibile pentru depunere.

### 3️⃣ Alege Deposit

Selectează:

**Deposit**

Apoi alege criptomoneda pe care dorești să o transferi.

### 4️⃣ Alege rețeaua

Aici este foarte important:

⚠️ Rețeaua aleasă trebuie să fie compatibilă cu rețeaua acceptată la destinație.

Dacă alegi o rețea greșită, transferul poate să nu ajungă unde trebuie.

### 5️⃣ Copiază adresa de depunere

OKX îți va afișa o adresă de deposit.

Copiază adresa cu atenție.

### 6️⃣ Introdu adresa în platforma NACE

În zona de alimentare/deposit a NACE, selectează aceeași monedă și aceeași rețea.

Introdu adresa copiată.

### 7️⃣ Introdu suma

Introdu suma pe care dorești să o transferi.

Verifică încă o dată:

✅ moneda  
✅ adresa  
✅ rețeaua  
✅ suma

### 8️⃣ Confirmă transferul

Confirmă tranzacția în OKX.

⏳ Transferul poate avea nevoie de timp pentru procesare și confirmări în blockchain.

### ⚠️ Recomandare

Înainte de o sumă mare, este recomandat să verifici foarte atent adresa și rețeaua și, dacă este cazul, să folosești o tranzacție de test.

❌ Nu trimite parola OKX nimănui.

❌ Nu trimite seed phrase.

❌ Nu trimite private key.

❌ Nu trimite coduri 2FA.
`;
}

/* =========================================================
   BINANCE TUTORIAL
========================================================= */

function binanceTutorial() {
  return `
💰 **TUTORIAL ALIMENTARE — BINANCE**

Dacă folosești Binance pentru alimentare, urmează pașii de mai jos.

### 1️⃣ Deschide Binance

Intră în aplicația sau site-ul Binance și conectează-te la contul tău.

### 2️⃣ Deschide Wallet / Assets

Intră în zona de portofel.

În funcție de versiunea aplicației, denumirile meniurilor pot fi diferite.

### 3️⃣ Selectează Deposit

Alege opțiunea:

**Deposit**

Apoi selectează criptomoneda pe care dorești să o transferi.

### 4️⃣ Selectează rețeaua

Alege rețeaua compatibilă cu destinația.

⚠️ Trebuie să fie aceeași rețea folosită la destinație.

Nu selecta o rețea doar pentru că are o taxă mai mică.

### 5️⃣ Copiază adresa

Binance îți va afișa adresa de depunere.

Copiază adresa exact.

### 6️⃣ Introdu adresa în NACE

În pagina de deposit/funding NACE:

➡️ selectează moneda  
➡️ selectează rețeaua corespunzătoare  
➡️ introdu adresa

### 7️⃣ Verifică datele

Înainte de confirmare verifică:

✅ moneda  
✅ rețeaua  
✅ adresa  
✅ suma

### 8️⃣ Confirmă transferul

Confirmă tranzacția din Binance.

Așteaptă procesarea și confirmările necesare.

### ⚠️ Foarte important

Blockchain-ul nu funcționează ca un transfer bancar obișnuit.

O adresă sau o rețea greșită poate cauza pierderea fondurilor.

❌ Nu trimite parola.

❌ Nu trimite seed phrase.

❌ Nu trimite private key.

❌ Nu trimite coduri 2FA.
`;
}

/* =========================================================
   BITGET TUTORIAL
========================================================= */

function bitgetTutorial() {
  return `
💰 **TUTORIAL ALIMENTARE — BITGET**

Dacă folosești Bitget, urmează pașii de mai jos.

### 1️⃣ Intră în Bitget

Deschide aplicația sau site-ul Bitget și conectează-te.

### 2️⃣ Intră în Assets

Deschide zona:

**Assets**

### 3️⃣ Alege Deposit

Selectează:

**Deposit**

Apoi alege moneda pe care dorești să o depui.

### 4️⃣ Selectează rețeaua

Alege rețeaua care este acceptată și de destinație.

⚠️ Rețeaua trebuie să corespundă pe ambele părți.

### 5️⃣ Copiază adresa

Copiază adresa de deposit afișată.

### 6️⃣ Deschide zona de alimentare NACE

Selectează aceeași monedă și aceeași rețea.

Introdu adresa Bitget.

### 7️⃣ Introdu suma

Verifică suma înainte de confirmare.

### 8️⃣ Confirmă

Confirmă tranzacția în Bitget și așteaptă procesarea.

### 🔐 Siguranță

Nu trimite niciodată:

❌ parola Bitget  
❌ seed phrase  
❌ private key  
❌ coduri 2FA  
❌ coduri de recuperare

Botul NACE Assistant nu are nevoie de aceste informații.
`;
}

/* =========================================================
   COPY TRADING TUTORIAL
========================================================= */

function copyTradingTutorial() {
  return `
📈 **TUTORIAL COMPLET — COPY TRADING**

Copy Trading este un mecanism prin care activitatea unui trader poate fi copiată automat sau semi-automat în funcție de setările disponibile pe platformă.

### 1️⃣ Intră în zona Copy Trading

După ce ai acces la cont, caută secțiunea:

**Copy Trading**

Denumirea exactă poate varia în funcție de versiunea platformei.

### 2️⃣ Analizează traderul

Nu alege un trader doar pentru că afișează profit.

Verifică, dacă informațiile sunt disponibile:

• istoricul  
• perioada de activitate  
• drawdown-ul  
• nivelul de risc  
• frecvența tranzacțiilor  
• strategia  
• rezultatele istorice

⚠️ Performanța trecută nu garantează rezultate viitoare.

### 3️⃣ Alege suma

Selectează suma pe care dorești să o aloci Copy Tradingului.

Nu folosi bani pe care nu îți permiți să îi pierzi.

### 4️⃣ Setează limitele de risc

Dacă platforma oferă astfel de opțiuni, verifică:

• suma maximă  
• pierderea maximă  
• stop loss  
• limitele de copiere  
• modul de închidere a pozițiilor

### 5️⃣ Activează Copy Trading

După ce ai verificat toate setările, confirmă activarea.

### 6️⃣ Monitorizează contul

Chiar dacă tranzacțiile sunt copiate automat, verifică periodic activitatea.

### 7️⃣ Oprirea Copy Tradingului

Dacă nu mai dorești să copiezi un trader, folosește opțiunea de:

**Stop Copy / Stop Copy Trading**

sau echivalentul disponibil în interfață.

### ⚠️ IMPORTANT

Copy Trading nu înseamnă profit garantat.

Pierderea este posibilă.

Nu copia o strategie doar pentru că altcineva a avut rezultate bune în trecut.

Folosește întotdeauna o gestionare responsabilă a riscului.
`;
}

/* =========================================================
   VERIFICATION TUTORIAL
========================================================= */

function verificationTutorial() {
  return `
📸 **VERIFICAREA CONTULUI ÎN DISCORD**

După ce ai finalizat pașii necesari în platformă, poți trimite screenshot-ul în DM către NACE Assistant.

### Screenshot-ul trebuie să arate clar:

✅ **Verified**

și

✅ **Found Account** sau **Trading Account**

și

✅ o sumă numerică de minimum **500**

### Exemple acceptate

500  
520  
750  
980  
1050  
1500  
1980  
2100  
2900  
3050

Nu este necesar ca suma să fie exact 500, 1000, 2000 sau 3000.

### Exemple respinse

❌ 100  
❌ 250  
❌ 499  
❌ screenshot fără Verified  
❌ screenshot fără Found Account / Trading Account  
❌ screenshot în care suma nu poate fi citită  
❌ imagine fără legătură cu contul

### 🔐 SIGURANȚĂ

Înainte să trimiți screenshot-ul, asigură-te că nu apar:

❌ parole  
❌ seed phrase  
❌ private keys  
❌ coduri 2FA  
❌ recovery codes

Botul verifică doar informațiile vizibile necesare.

După aprobare, botul poate acorda rolul:

🎖️ **Trader**
`;
}

/* =========================================================
   SIGNALS INFO
========================================================= */

function signalsInfo() {
  return `
🚨 **SEMNALE & BONUSURI NACE**

### 📢 Semnale normale

Membrii cu rolurile:

🎖️ Trader  
👑 Team Leader  
🛡️ Moderator  
⚙️ Admin

sunt menționați pentru semnalele normale.

Program:

🕛 **12:10** — Signal 1

🕔 **17:10** — Signal 2

🕗 **20:10** — Signal 3

### 🎁 Bonus membru nou

La intrarea pe server, membrul este înregistrat în sistem.

Perioada bonusului:

⏳ **3 zile**

Semnalul bonus este programat la:

🕐 **13:00**

### 👑 Bonus Team Leader

Pentru formarea unei echipe complete de:

👥 **5 membri**

Team Leader-ul primește o perioadă de bonus de:

⏳ **20 zile**

Semnalul Team Leader este programat la:

🕧 **12:30**

### 📊 Status

Poți folosi:

\`/status\`

pentru a verifica informațiile disponibile despre statutul tău în sistem.

⚠️ Semnalele și informațiile de trading nu reprezintă o garanție de profit.
`;
}

/* =========================================================
   HELP
========================================================= */

function helpMessage() {
  return `
❓ **NACE ASSISTANT — AJUTOR**

Salut! Sunt asistentul comunității.

Te pot ajuta cu:

🚀 **Înregistrarea NACE**
  
💰 **Alimentarea contului**

📈 **Copy Trading**

📸 **Verificarea contului**

🚨 **Semnale și bonusuri**

👥 **Echipe și Team Leader**

📊 **Statusul contului în comunitate**

### Comenzi utile

\`/status\`

Vezi statusul tău.

\`/team create\`

Poate fi folosit pentru formarea unei echipe de 5 membri.

### 🔐 Siguranță

Niciodată nu trimite:

❌ parola  
❌ seed phrase  
❌ private key  
❌ cod 2FA  
❌ recovery code

Dacă ai o problemă cu platforma, verifică mai întâi informațiile oficiale disponibile în platformă.
`;
}

/* =========================================================
   SLASH COMMANDS
========================================================= */

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Vezi statusul tău NACE"),

  new SlashCommandBuilder()
    .setName("team")
    .setDescription("Gestionare echipe")

    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Creează o echipă de 5 membri")

        .addUserOption((option) =>
          option
            .setName("member1")
            .setDescription("Team Leader")
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

    .addSubcommand((sub) =>
      sub
        .setName("member")
        .setDescription(
          "Vezi informațiile unui membru"
        )

        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Membrul")
            .setRequired(true)
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("team")
        .setDescription(
          "Vezi informațiile unei echipe"
        )

        .addUserOption((option) =>
          option
            .setName("leader")
            .setDescription("Team Leader")
            .setRequired(true)
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("members")
        .setDescription(
          "Vezi membrii din baza de date"
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("teams")
        .setDescription(
          "Vezi echipele din baza de date"
        )
    ),
];

/* =========================================================
   REGISTER SLASH COMMANDS
========================================================= */

async function registerCommands() {
  try {
    const rest = new REST({
      version: "10",
    }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        GUILD_ID
      ),
      {
        body: commands.map((command) =>
          command.toJSON()
        ),
      }
    );

    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error(
      "registerCommands:",
      error
    );
  }
}

/* =========================================================
   READY
========================================================= */

client.once("clientReady", async () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );

  await registerCommands();

  console.log(
    "🤖 NACE Assistant is online."
  );

  checkSignals();

  setInterval(
    checkSignals,
    30 * 1000
  );
});

/* =========================================================
   NEW MEMBER
========================================================= */

client.on(
  "guildMemberAdd",
  async (member) => {
    try {
      console.log(
        `👤 New member: ${member.user.tag}`
      );

      await saveMember(member);

      await activateNewMemberBonus(
        member.id
      );

      const welcomeEmbed =
        new EmbedBuilder()
          .setTitle(
            `👋 Bine ai venit în NACE, ${member.user.username}!`
          )
          .setDescription(
            `
Salut și bine ai venit în comunitatea **NACE**! 🚀

**NACE Assistant** este botul care te poate ghida prin pașii principali de onboarding și te poate ajuta să înțelegi sistemul comunității.

Înainte să începi, este important să știi că botul nu îți va cere niciodată parola, seed phrase, private key, coduri 2FA sau coduri de recuperare.

### 📚 Cu ce te pot ajuta?

🚀 **Înregistrare NACE**
  
Îți explic pas cu pas procesul de înregistrare și ce trebuie să faci după crearea contului.

💰 **Alimentare cont**

Ai tutoriale separate pentru OKX, Binance și Bitget.

📈 **Copy Trading**

Îți explic ce este Copy Trading, ce trebuie să verifici și cum să fii atent la risc.

📸 **Verificare cont**

După ce ai finalizat pașii necesari, poți trimite screenshot-ul pentru verificarea rolului Trader.

### 🎁 Bonus membru nou

Ai fost înregistrat automat pentru perioada de bonus de **3 zile**.

Semnalul bonus pentru membrii noi este programat la:

🕐 **13:00**

### 🚨 Semnale normale

Semnalele normale sunt programate la:

🕛 **12:10**
🕔 **17:10**
🕗 **20:10**

### 👑 Team Leader

După formarea unei echipe complete de **5 membri**, Team Leader-ul poate avea o perioadă de bonus de **20 zile**.

Semnalul Team Leader este programat la:

🕧 **12:30**

Apasă butoanele de mai jos pentru tutorialul dorit.
`
          )
          .setFooter({
            text: "NACE Assistant • Nu trimite niciodată date sensibile.",
          });

      await member.send({
        embeds: [welcomeEmbed],
        components: tutorialButtons(),
      });

      await member.send({
        content:
          "📖 **RECOMANDAREA MEA:** începe cu **🚀 Înregistrare NACE**, apoi continuă cu alimentarea, Copy Trading și, la final, verificarea contului.",
      });

      console.log(
        `✅ Welcome DM sent to ${member.user.tag}`
      );
    } catch (error) {
      console.error(
        "guildMemberAdd:",
        error
      );
    }
  }
);

/* =========================================================
   BUTTON INTERACTIONS
========================================================= */

client.on(
  "interactionCreate",
  async (interaction) => {
    if (!interaction.isButton()) return;

    try {
      /* =========================
         REGISTER
      ========================= */

      if (
        interaction.customId ===
        "register_nace"
      ) {
        const chunks =
          chunkText(
            registrationTutorial()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         FUNDING
      ========================= */

      if (
        interaction.customId ===
        "funding"
      ) {
        await interaction.reply({
          content: `
💰 **Alege platforma pentru tutorialul de alimentare:**

Vei primi pașii specifici pentru platforma aleasă.

⚠️ Verifică întotdeauna moneda, adresa și rețeaua înainte de confirmarea unui transfer.
`,
          components:
            fundingPlatformButtons(),
          ephemeral: true,
        });

        return;
      }

      /* =========================
         OKX
      ========================= */

      if (
        interaction.customId ===
        "fund_okx"
      ) {
        const chunks =
          chunkText(
            okxTutorial()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         BINANCE
      ========================= */

      if (
        interaction.customId ===
        "fund_binance"
      ) {
        const chunks =
          chunkText(
            binanceTutorial()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         BITGET
      ========================= */

      if (
        interaction.customId ===
        "fund_bitget"
      ) {
        const chunks =
          chunkText(
            bitgetTutorial()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         COPY TRADING
      ========================= */

      if (
        interaction.customId ===
        "copy_trading"
      ) {
        const chunks =
          chunkText(
            copyTradingTutorial()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         VERIFICATION
      ========================= */

      if (
        interaction.customId ===
        "verify_account"
      ) {
        const chunks =
          chunkText(
            verificationTutorial()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         SIGNALS
      ========================= */

      if (
        interaction.customId ===
        "signals_info"
      ) {
        const chunks =
          chunkText(
            signalsInfo()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }

      /* =========================
         HELP
      ========================= */

      if (
        interaction.customId ===
        "help_nace"
      ) {
        const chunks =
          chunkText(
            helpMessage()
          );

        await interaction.reply({
          content: chunks[0],
          ephemeral: true,
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await interaction.followUp({
            content: chunks[i],
            ephemeral: true,
          });
        }

        return;
      }
    } catch (error) {
      console.error(
        "Button interaction:",
        error
      );

      if (!interaction.replied) {
        await interaction.reply({
          content:
            "❌ A apărut o eroare. Încearcă din nou.",
          ephemeral: true,
        });
      }
    }
  }
);

/* =========================================================
   SLASH COMMAND INTERACTIONS
========================================================= */

client.on(
  "interactionCreate",
  async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      /* =====================================================
         STATUS
      ===================================================== */

      if (
        interaction.commandName ===
        "status"
      ) {
        const data =
          await getMemberData(
            interaction.user.id
          );

        if (!data) {
          await interaction.reply({
            content:
              "❌ Nu am găsit datele tale în sistem.",
            ephemeral: true,
          });

          return;
        }

        const now = new Date();

        let newMemberStatus =
          "❌ Inactiv";

        if (
          data.new_member_bonus_start &&
          data.new_member_bonus_end
        ) {
          const start = new Date(
            data.new_member_bonus_start
          );

          const end = new Date(
            data.new_member_bonus_end
          );

          if (
            now >= start &&
            now <= end
          ) {
            newMemberStatus =
              `✅ Activ până la ${end.toLocaleString(
                "ro-RO"
              )}`;
          }
        }

        let teamStatus =
          "❌ Inactiv";

        if (
          data.is_team_leader &&
          data.team_bonus_start &&
          data.team_bonus_end
        ) {
          const start = new Date(
            data.team_bonus_start
          );

          const end = new Date(
            data.team_bonus_end
          );

          if (
            now >= start &&
            now <= end
          ) {
            teamStatus =
              `✅ Activ până la ${end.toLocaleString(
                "ro-RO"
              )}`;
          }
        }

        const role =
          interaction.member.roles.cache.find(
            (r) =>
              [
                "Trader",
                "Team Leader",
                "Moderator",
                "Admin",
              ].includes(r.name)
          );

        await interaction.reply({
          content: `
📊 **STATUS NACE**

👤 Membru: <@${interaction.user.id}>

🎖️ Rol:
${
  role
    ? `**${role.name}**`
    : "Niciun rol special"
}

🎁 Bonus membru nou:
${newMemberStatus}

👑 Team Leader:
${
  data.is_team_leader
    ? "✅ Da"
    : "❌ Nu"
}

👥 Team ID:
${
  data.team_id
    ? `**${data.team_id}**`
    : "Nu ai echipă"
}

👑 Bonus Team Leader:
${teamStatus}
`,
          ephemeral: true,
        });

        return;
      }

      /* =====================================================
         TEAM CREATE
      ===================================================== */

      if (
        interaction.commandName ===
          "team" &&
        interaction.options.getSubcommand() ===
          "create"
      ) {
        const member1 =
          interaction.options.getUser(
            "member1"
          );

        const member2 =
          interaction.options.getUser(
            "member2"
          );

        const member3 =
          interaction.options.getUser(
            "member3"
          );

        const member4 =
          interaction.options.getUser(
            "member4"
          );

        const member5 =
          interaction.options.getUser(
            "member5"
          );

        const members = [
          member1,
          member2,
          member3,
          member4,
          member5,
        ];

        const memberIds =
          members.map(
            (member) => member.id
          );

        if (
          new Set(memberIds).size !== 5
        ) {
          await interaction.reply({
            content:
              "❌ Toți cei 5 membri trebuie să fie diferiți.",
            ephemeral: true,
          });

          return;
        }

        const leaderId =
          member1.id;

        const result =
          await createTeamInDatabase(
            leaderId,
            memberIds
          );

        if (!result.success) {
          await interaction.reply({
            content:
              `❌ ${result.error}`,
            ephemeral: true,
          });

          return;
        }

        const guild =
          interaction.guild;

        const leaderMember =
          await guild.members.fetch(
            leaderId
          );

        const teamLeaderRole =
          guild.roles.cache.find(
            (role) =>
              role.name ===
              "Team Leader"
          );

        if (teamLeaderRole) {
          await leaderMember.roles.add(
            teamLeaderRole
          );
        }

        await interaction.reply({
          content: `
✅ **ECHIPĂ CREATĂ**

👑 Team Leader:
<@${leaderId}>

👥 Membri:
<@${memberIds[1]}>
<@${memberIds[2]}>
<@${memberIds[3]}>
<@${memberIds[4]}>

📋 Team ID:
**${result.team.id}**

🎁 Bonus Team Leader:
**20 zile**

📅 Bonus început:
${new Date(
  result.team.bonus_start
).toLocaleString("ro-RO")}

📅 Bonus terminat:
${new Date(
  result.team.bonus_end
).toLocaleString("ro-RO")}
`,
          ephemeral: false,
        });

        return;
      }

      /* =====================================================
         ADMIN
      ===================================================== */

      if (
        interaction.commandName ===
        "admin"
      ) {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content:
              "❌ Nu ai permisiuni de administrator.",
            ephemeral: true,
          });

          return;
        }

        const subcommand =
          interaction.options.getSubcommand();

        /* =================================================
           ADMIN MEMBER
        ================================================= */

        if (
          subcommand ===
          "member"
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
            await interaction.reply({
              content:
                "❌ Membrul nu există în baza de date.",
              ephemeral: true,
            });

            return;
          }

          await interaction.reply({
            content: `
🛡️ **ADMIN — MEMBER**

👤 User:
<@${user.id}>

🆔 Discord ID:
\`${user.id}\`

📛 Username:
**${data.username || user.username}**

👑 Team Leader:
**${data.is_team_leader ? "DA" : "NU"}**

👥 Team ID:
**${data.team_id || "N/A"}**

🎁 New Member Bonus:
**${data.new_member_bonus_start || "N/A"}**
→
**${data.new_member_bonus_end || "N/A"}**

👑 Team Bonus:
**${data.team_bonus_start || "N/A"}**
→
**${data.team_bonus_end || "N/A"}**

🕐 Updated:
**${data.updated_at || "N/A"}**
`,
            ephemeral: true,
          });

          return;
        }

        /* =================================================
           ADMIN TEAM
        ================================================= */

        if (
          subcommand ===
          "team"
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
            console.error(
              "admin team:",
              error
            );

            await interaction.reply({
              content:
                "❌ Eroare la citirea echipei.",
              ephemeral: true,
            });

            return;
          }

          if (!data) {
            await interaction.reply({
              content:
                "❌ Nu am găsit o echipă pentru acest Team Leader.",
              ephemeral: true,
            });

            return;
          }

          await interaction.reply({
            content: `
🛡️ **ADMIN — TEAM**

📋 Team ID:
**${data.id}**

👑 Team Leader:
<@${data.leader_discord_id}>

👥 Membri:

1. <@${data.member_1}>
2. <@${data.member_2}>
3. <@${data.member_3}>
4. <@${data.member_4}>
5. <@${data.member_5}>

📅 Formată:
${data.formed_at}

🎁 Bonus început:
${data.bonus_start}

🎁 Bonus sfârșit:
${data.bonus_end}
`,
            ephemeral: true,
          });

          return;
        }

        /* =================================================
           ADMIN MEMBERS
        ================================================= */

        if (
          subcommand ===
          "members"
        ) {
          const { data, error } =
            await supabase
              .from("members")
              .select("*")
              .order(
                "updated_at",
                {
                  ascending: false,
                }
              );

          if (error) {
            console.error(
              "admin members:",
              error
            );

            await interaction.reply({
              content:
                "❌ Nu am putut încărca membrii.",
              ephemeral: true,
            });

            return;
          }

          if (
            !data ||
            data.length === 0
          ) {
            await interaction.reply({
              content:
                "ℹ️ Nu există membri în baza de date.",
              ephemeral: true,
            });

            return;
          }

          let text =
            "🛡️ **ADMIN — TOȚI MEMBRII**\n\n";

          for (
            let i = 0;
            i < data.length;
            i++
          ) {
            const member =
              data[i];

            text +=
              `**${i + 1}.** <@${member.discord_id}>\n` +
              `🆔 ${member.discord_id}\n` +
              `👑 Team Leader: ${
                member.is_team_leader
                  ? "DA"
                  : "NU"
              }\n` +
              `👥 Team: ${
                member.team_id ||
                "N/A"
              }\n\n`;
          }

          const chunks =
            chunkText(text);

          await interaction.reply({
            content: chunks[0],
            ephemeral: true,
          });

          for (
            let i = 1;
            i < chunks.length;
            i++
          ) {
            await interaction.followUp({
              content: chunks[i],
              ephemeral: true,
            });
          }

          return;
        }

        /* =================================================
           ADMIN TEAMS
        ================================================= */

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
            console.error(
              "admin teams:",
              error
            );

            await interaction.reply({
              content:
                "❌ Nu am putut încărca echipele.",
              ephemeral: true,
            });

            return;
          }

          if (
            !data ||
            data.length === 0
          ) {
            await interaction.reply({
              content:
                "ℹ️ Nu există echipe în baza de date.",
              ephemeral: true,
            });

            return;
          }

          let text =
            "🛡️ **ADMIN — TOATE ECHIPELE**\n\n";

          for (
            let i = 0;
            i < data.length;
            i++
          ) {
            const team =
              data[i];

            text +=
              `**Echipa ${i + 1}**\n` +
              `📋 ID: ${team.id}\n` +
              `👑 Leader: <@${team.leader_discord_id}>\n` +
              `👥 Membri: <@${team.member_1}> <@${team.member_2}> <@${team.member_3}> <@${team.member_4}> <@${team.member_5}>\n` +
              `📅 Formată: ${team.formed_at}\n` +
              `🎁 Bonus până: ${team.bonus_end}\n\n`;
          }

          const chunks =
            chunkText(text);

          await interaction.reply({
            content: chunks[0],
            ephemeral: true,
          });

          for (
            let i = 1;
            i < chunks.length;
            i++
          ) {
            await interaction.followUp({
              content: chunks[i],
              ephemeral: true,
            });
          }

          return;
        }
      }
    } catch (error) {
      console.error(
        "Slash command:",
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

/* =========================================================
   DM SCREENSHOT VERIFICATION
========================================================= */

client.on(
  "messageCreate",
  async (message) => {
    try {
      if (message.author.bot) {
        return;
      }

      /* Doar DM */
      if (message.guild) {
        return;
      }

      /* Nu există attachment */
      if (
        message.attachments.size === 0
      ) {
        return;
      }

      const attachment =
        message.attachments.first();

      if (!attachment) {
        return;
      }

      /* Verificăm dacă este imagine */
      const isImage =
        attachment.contentType?.startsWith(
          "image/"
        ) ||
        /\.(png|jpg|jpeg|webp)$/i.test(
          attachment.name || ""
        );

      if (!isImage) {
        await message.reply(
          "❌ Te rog trimite un screenshot ca imagine (PNG/JPG/JPEG/WEBP)."
        );

        return;
      }

      await message.reply(
        "🔎 **Screenshot primit.**\n\nÎl verific acum. Nu trimite parole, seed phrase, private keys sau coduri 2FA."
      );

      const result =
        await verifyScreenshot(
          attachment.url
        );

      if (result.approved) {
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

        if (!traderRole) {
          await message.reply(
            "❌ Rolul Trader nu a fost găsit. Contactează un administrator."
          );

          return;
        }

        if (
          !member.roles.cache.has(
            traderRole.id
          )
        ) {
          await member.roles.add(
            traderRole
          );
        }

        await saveMember(
          member
        );

        await message.reply(`
✅ **CONT VERIFICAT CU SUCCES!**

Am identificat:

✅ Verified  
✅ Found Account / Trading Account  
✅ Sumă: **${result.amount}**

💰 Suma identificată:
**${result.amount}**

🎖️ Ai primit rolul:
**Trader**

🚨 De acum poți fi inclus în sistemul de semnale normale conform rolurilor configurate.

⚠️ Nu trimite niciodată datele tale de autentificare sau datele de securitate nimănui.
`);

        console.log(
          `✅ Verified ${message.author.tag} | amount=${result.amount}`
        );
      } else {
        await message.reply(`
❌ **SCREENSHOT RESPINS**

Screenshot-ul nu îndeplinește toate condițiile.

Trebuie să fie vizibile clar:

✅ **Verified**

și

✅ **Found Account** sau **Trading Account**

și

✅ o sumă de minimum **500**

💰 Suma identificată:
**${result.amount || 0}**

📋 Motiv:
${result.reason}

Te rog verifică screenshot-ul și retrimite unul mai clar.

⚠️ Nu include parole, seed phrase, private keys sau coduri 2FA.
`);

        console.log(
          `❌ Screenshot rejected ${message.author.tag} | ${result.reason}`
        );
      }
    } catch (error) {
      console.error(
        "messageCreate:",
        error
      );

      try {
        await message.reply(
          "❌ A apărut o eroare la verificarea screenshot-ului. Încearcă din nou sau contactează un administrator."
        );
      } catch {}
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

client
  .login(DISCORD_TOKEN)
  .catch((error) => {
    console.error(
      "❌ Discord login failed:",
      error
    );
  });
