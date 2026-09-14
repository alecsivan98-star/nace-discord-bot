require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
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
   - It must clearly indicate that the account/user is verified.
   - If "Verified" is missing or unclear, reject.

2. A visible account section is present.
   Accept either:
   - "Found Account"
   - "Trading Account"
   The wording must be reasonably clear.
   If neither is visible, reject.

3. A numerical account/trading amount is visible.
   - The amount must be at least 500.
   - Values around 500, 1000, 2000, 3000 and values between/around those amounts are acceptable.
   - Examples that can be acceptable: 500, 520, 750, 980, 1050, 1500, 1980, 2100, 2900, 3050, etc.
   - Any amount below 500 must be rejected.
   - Do not require the amount to be exactly 500, 1000, 2000 or 3000.

4. The screenshot must provide reasonably clear visual evidence.
   - Do not approve an unrelated image.
   - Do not guess missing information.
   - If text or amount cannot be read reliably, reject.

IMPORTANT:
- Do not request or extract passwords.
- Do not request or extract private keys.
- Do not request or extract seed phrases.
- Do not request or extract 2FA/recovery codes.
- Only evaluate the visible verification/account information.

Return ONLY JSON in this exact structure:

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

The "amount" field must contain the numeric amount you can actually read from the screenshot.
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

  // Verificare suplimentară făcută de bot,
  // nu lăsăm AI-ul să decidă singur regula minimă.
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

client.once("ready", () => {
  console.log(`NACE Assistant conectat ca ${client.user.tag}`);
});

client.on("guildMemberAdd", async (member) => {
  try {
    await member.send(
      `👋 **Bine ai venit în comunitatea NACE!**\n\n` +
      `NACE este o platformă de tranzacționare crypto care oferă servicii precum Spot Trading, Futures, Copy Trading și NACE Finance.\n\n` +
      `🌐 Site oficial: ${NACE_URL}\n\n` +
      `Pentru a primi rolul **Trader**, te rog să te înregistrezi pe NACE și apoi să-mi trimiți aici, în privat, **un screenshot care confirmă înregistrarea**.\n\n` +
      `📸 Trimite screenshot-ul direct în acest chat.`
    );
  } catch (error) {
    console.error(
      `Nu am putut trimite DM către ${member.user.tag}:`,
      error.message
    );
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Verificarea se face numai prin DM.
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

    if (!image) {
      await message.reply(
        "📸 Te rog să-mi trimiți screenshot-ul înregistrării pe NACE ca imagine."
      );
      return;
    }

    await message.reply(
      "⏳ Am primit screenshot-ul. Verific dacă apare Verified, contul și suma..."
    );

    const result = await verifyScreenshot(image.url);

    console.log(`Rezultat verificare pentru ${message.author.tag}:`, result);

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
    console.error("Eroare la verificarea screenshotului:", error);

    try {
      await message.reply(
        "❌ A apărut o eroare în timpul verificării. Încearcă din nou."
      );
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
