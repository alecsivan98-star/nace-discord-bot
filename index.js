require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const OpenAI = require("openai");

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

const GUILD_ID = process.env.GUILD_ID;
const TRADER_ROLE_ID = process.env.TRADER_ROLE_ID;
const NACE_URL = process.env.NACE_URL || "https://nacetuin.com/";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

/* =========================================================
   VERIFICARE SCREENSHOT
========================================================= */

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
   OR
   - "Trading Account"
3. A numerical account/trading amount is visible.
4. The amount must be at least 500.
5. The screenshot must provide reasonably clear visual evidence.

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

The amount field must contain the numeric amount actually visible.
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

/* =========================================================
   ROL TRADER
========================================================= */

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

/* =========================================================
   MENIU PRINCIPAL
========================================================= */

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
    content:
      `🤖 **NACE Assistant**\n\n` +
      `Te ghidez pas cu pas prin procesul NACE.\n\n` +
      `Alege ce vrei să faci:`,
    components: [row1, row2],
  };
}

/* =========================================================
   TUTORIAL ÎNREGISTRARE NACE
========================================================= */

function registrationTutorial() {
  return {
    content:
      `🚀 **TUTORIAL COMPLET — ÎNREGISTRARE NACE**\n\n` +

      `**1️⃣ Intră pe NACE**\n` +
      `${NACE_URL}\n\n` +

      `**2️⃣ Creează contul**\n` +
      `Apasă pe opțiunea de înregistrare și completează datele solicitate de NACE.\n\n` +

      `**3️⃣ Confirmă contul**\n` +
      `Urmează pașii de confirmare afișați de platformă.\n\n` +

      `**4️⃣ Intră în cont**\n` +
      `După înregistrare, conectează-te în contul NACE.\n\n` +

      `**5️⃣ Verificarea identității**\n` +
      `Dacă platforma îți solicită verificarea identității/KYC, urmează pașii afișați direct în NACE.\n\n` +

      `🔐 **Important:** nu trimite nimănui parola, codurile 2FA, seed phrase sau cheia privată.\n\n` +

      `**6️⃣ Intră în zona de trading**\n` +
      `După ce ai terminat înregistrarea și verificările solicitate, intră în contul tău și verifică zona de trading.\n\n` +

      `**7️⃣ Alimentează contul**\n` +
      `Dacă vrei să depui crypto, apasă pe butonul **💰 Alimentare cont** și alege tutorialul pentru OKX, Binance sau Bitget.\n\n` +

      `**8️⃣ Verifică depunerea**\n` +
      `După transfer, verifică dacă fondurile au ajuns și dacă informațiile contului sunt afișate corect.\n\n` +

      `**9️⃣ Ultimul pas**\n` +
      `După ce ai finalizat procesul, trimite screenshot-ul aici în DM pentru verificarea automată.\n\n` +

      `📸 **Nu trimite screenshot-ul înainte să fie vizibile informațiile necesare pentru verificare.**`,
  };
}

/* =========================================================
   MENIU ALIMENTARE
========================================================= */

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
      `Alege platforma de pe care vrei să trimiți crypto către NACE:\n\n` +
      `🟢 OKX\n` +
      `🟡 Binance\n` +
      `🔵 Bitget\n\n` +
      `⚠️ Înainte de orice transfer verifică întotdeauna moneda, adresa și rețeaua afișate în contul NACE.`,
    components: [row],
  };
}

/* =========================================================
   OKX
========================================================= */

function okxTutorial() {
  return {
    content:
      `🟢 **TUTORIAL OKX → NACE**\n\n` +

      `**1️⃣ Creează cont OKX**\n` +
      `Înregistrează-te pe OKX și urmează pașii solicitați pentru verificarea contului.\n\n` +

      `**2️⃣ Cumpără crypto**\n` +
      `Cumpără moneda pe care intenționezi să o trimiți către NACE, dacă este disponibilă pentru metoda ta de plată.\n\n` +

      `**3️⃣ Intră în Assets**\n` +
      `Deschide zona de active și selectează opțiunea de retragere/Withdraw.\n\n` +

      `**4️⃣ Alege moneda**\n` +
      `Selectează moneda pe care NACE o afișează la Deposit.\n\n` +

      `**5️⃣ Copiază adresa din NACE**\n` +
      `În NACE intră la Deposit și copiază adresa afișată.\n\n` +

      `**6️⃣ Alege REȚEAUA CORECTĂ**\n` +
      `Rețeaua selectată în OKX trebuie să fie exact aceeași cu cea afișată de NACE.\n\n` +

      `**7️⃣ Verifică înainte de trimitere**\n` +
      `✔ moneda\n` +
      `✔ adresa\n` +
      `✔ rețeaua\n` +
      `✔ suma\n\n` +

      `**8️⃣ Confirmă retragerea**\n` +
      `După ce ai verificat toate datele, confirmă transferul.\n\n` +

      `⚠️ **Nu folosi o adresă sau o rețea oferită de altă persoană. Folosește întotdeauna datele afișate în contul tău NACE.**`,
  };
}

/* =========================================================
   BINANCE
========================================================= */

function binanceTutorial() {
  return {
    content:
      `🟡 **TUTORIAL BINANCE → NACE**\n\n` +

      `**1️⃣ Creează cont Binance**\n` +
      `Înregistrează-te și urmează procedura de verificare solicitată de Binance.\n\n` +

      `**2️⃣ Cumpără crypto**\n` +
      `Cumpără moneda pe care vrei să o trimiți către NACE.\n\n` +

      `**3️⃣ Deschide Withdraw / Retragere**\n` +
      `Intră în zona de retragere crypto.\n\n` +

      `**4️⃣ Alege moneda**\n` +
      `Selectează aceeași monedă pe care ai ales-o la Deposit în NACE.\n\n` +

      `**5️⃣ Copiază adresa NACE**\n` +
      `Intră în NACE → Deposit și copiază adresa afișată acolo.\n\n` +

      `**6️⃣ Selectează rețeaua**\n` +
      `Alege exact aceeași rețea pe care o afișează NACE pentru depunerea respectivă.\n\n` +

      `**7️⃣ Verifică datele**\n` +
      `✔ adresa\n` +
      `✔ moneda\n` +
      `✔ rețeaua\n` +
      `✔ suma\n\n` +

      `**8️⃣ Confirmă transferul**\n` +
      `Confirmă retragerea după ce ai verificat toate datele.\n\n` +

      `⚠️ **O rețea greșită poate duce la pierderea fondurilor. Nu ghici niciodată rețeaua.**`,
  };
}

/* =========================================================
   BITGET
========================================================= */

function bitgetTutorial() {
  return {
    content:
      `🔵 **TUTORIAL BITGET → NACE**\n\n` +

      `**1️⃣ Creează cont Bitget**\n` +
      `Înregistrează-te și finalizează pașii solicitați de Bitget.\n\n` +

      `**2️⃣ Cumpără crypto**\n` +
      `Cumpără moneda pe care dorești să o transferi către NACE.\n\n` +

      `**3️⃣ Intră la Withdraw**\n` +
      `Deschide zona de retragere crypto.\n\n` +

      `**4️⃣ Alege moneda**\n` +
      `Selectează moneda disponibilă pentru depunerea ta în NACE.\n\n` +

      `**5️⃣ Copiază adresa din NACE**\n` +
      `În NACE deschide Deposit și copiază adresa afișată.\n\n` +

      `**6️⃣ Selectează aceeași rețea**\n` +
      `Rețeaua din Bitget trebuie să corespundă exact cu cea afișată de NACE.\n\n` +

      `**7️⃣ Verifică totul**\n` +
      `✔ moneda\n` +
      `✔ adresa\n` +
      `✔ rețeaua\n` +
      `✔ suma\n\n` +

      `**8️⃣ Confirmă transferul**\n` +
      `După verificarea datelor, confirmă retragerea.\n\n` +

      `⚠️ **Nu trimite fondurile până când moneda, adresa și rețeaua nu au fost verificate.**`,
  };
}

/* =========================================================
   COPY TRADING
========================================================= */

function copyTradingTutorial() {
  return {
    content:
      `📈 **TUTORIAL COPY TRADING NACE**\n\n` +

      `**1️⃣ Intră în Copy Trading**\n` +
      `Deschide secțiunea **Copy Trading** din contul NACE.\n\n` +

      `**2️⃣ Analizează traderii**\n` +
      `Nu alege automat primul trader. Uită-te la informațiile și statisticile disponibile.\n\n` +

      `**3️⃣ Verifică riscul**\n` +
      `Uită-te la performanță, drawdown, istoricul activității și celelalte date disponibile.\n\n` +

      `**4️⃣ Alege traderul**\n` +
      `Deschide profilul traderului și verifică informațiile înainte de a începe copierea.\n\n` +

      `**5️⃣ Configurează copierea**\n` +
      `Alege suma și parametrii disponibili pentru Copy Trading.\n\n` +

      `**6️⃣ Activează Copy Trading**\n` +
      `Confirmă setările și pornește copierea.\n\n` +

      `**7️⃣ Monitorizează rezultatele**\n` +
      `Verifică periodic contul și pozițiile copiate.\n\n` +

      `**8️⃣ Oprește copierea**\n` +
      `Dacă vrei să te oprești, folosește opțiunea disponibilă de Stop/Disable Copy Trading.\n\n` +

      `⚠️ **Important:** Copy Trading nu garantează profit. Poți pierde bani, inclusiv o parte sau toată suma alocată, în funcție de tranzacții și de riscul asumat.`,
  };
}

/* =========================================================
   VERIFICARE CONT
========================================================= */

function verificationTutorial() {
  return {
    content:
      `📸 **VERIFICAREA CONTULUI NACE**\n\n` +

      `Ai terminat pașii? Trimite screenshot-ul aici în DM.\n\n` +

      `Pentru aprobare trebuie să fie vizibile clar:\n\n` +

      `☑️ **Verified**\n` +
      `☑️ **Found Account** sau **Trading Account**\n` +
      `☑️ o sumă de minimum **500**\n\n` +

      `Dacă toate condițiile sunt îndeplinite, botul îți acordă automat rolul **Trader**.\n\n` +

      `🔐 Nu trimite parole, seed phrase, chei private sau coduri 2FA.`,
  };
}

/* =========================================================
   BOT READY
========================================================= */

client.once("ready", () => {
  console.log(`NACE Assistant conectat ca ${client.user.tag}`);
});

/* =========================================================
   MEMBRU NOU
========================================================= */

client.on("guildMemberAdd", async (member) => {
  try {
    await member.send(mainMenu());
  } catch (error) {
    console.error(
      `Nu am putut trimite DM către ${member.user.tag}:`,
      error.message
    );
  }
});

/* =========================================================
   BUTOANE
========================================================= */

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    if (interaction.customId === "nace_register") {
      await interaction.reply(registrationTutorial());
      return;
    }

    if (interaction.customId === "nace_funding") {
      await interaction.reply(fundingMenu());
      return;
    }

    if (interaction.customId === "fund_okx") {
      await interaction.reply(okxTutorial());
      return;
    }

    if (interaction.customId === "fund_binance") {
      await interaction.reply(binanceTutorial());
      return;
    }

    if (interaction.customId === "fund_bitget") {
      await interaction.reply(bitgetTutorial());
      return;
    }

    if (interaction.customId === "nace_copy") {
      await interaction.reply(copyTradingTutorial());
      return;
    }

    if (interaction.customId === "nace_verify") {
      await interaction.reply(verificationTutorial());
      return;
    }
  } catch (error) {
    console.error("Eroare buton:", error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(
        "❌ A apărut o eroare. Încearcă din nou."
      );
    }
  }
});

/* =========================================================
   SCREENSHOT VERIFICATION
========================================================= */

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Screenshoturile se verifică numai prin DM.
    if (message.guild) return;

    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);

    if (!guild) {
      console.error("Serverul Discord nu a fost găsit.");
      return;
    }

    const member = await guild.members
      .fetch(message.author.id)
      .catch(() => null);

    if (!member) {
      await message.reply(
        "Nu te găsesc pe serverul NACE. Intră pe server și încearcă din nou."
      );
      return;
    }

    const image = message.attachments.find((attachment) => {
      return (
        attachment.contentType &&
        attachment.contentType.startsWith("image/")
      );
    });

    // Dacă nu este imagine, nu mai trimitem automat mesajul vechi
    // despre screenshot. Permitem utilizatorului să discute cu meniul.
    if (!image) {
      return;
    }

    await message.reply(
      "⏳ Am primit screenshot-ul. Verific dacă apare Verified, contul și suma..."
    );

    const result = await verifyScreenshot(image.url);

    console.log(
      `Rezultat verificare pentru ${message.author.tag}:`,
      result
    );

    if (result.approved) {
      await giveTraderRole(member);

      await message.reply(
        `✅ **Verificarea a fost aprobată!**\n\n` +
          `☑️ Verified: da\n` +
          `☑️ Cont: găsit\n` +
          `💰 Sumă detectată: ${result.amount}\n\n` +
          `🎉 Ți-am acordat rolul **Trader** pe serverul NACE.`
      );
    } else {
      await message.reply(
        `❌ **Verificarea nu a fost aprobată.**\n\n` +
          `${result.reason}\n\n` +
          `Condițiile necesare sunt:\n` +
          `• să apară **Verified**;\n` +
          `• să apară **Found Account** sau **Trading Account**;\n` +
          `• suma contului să fie de cel puțin **500**.\n\n` +
          `📸 Trimite un screenshot mai clar și voi verifica din nou.\n\n` +
          `🔐 Nu trimite parole, seed phrase, chei private sau coduri 2FA.`
      );
    }
  } catch (error) {
    console.error(
      "Eroare la verificarea screenshotului:",
      error
    );

    try {
      await message.reply(
        "❌ A apărut o eroare în timpul verificării. Încearcă din nou."
      );
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
