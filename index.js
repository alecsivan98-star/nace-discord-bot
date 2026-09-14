require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const GUILD_ID = process.env.GUILD_ID;
const TRADER_ROLE_ID = process.env.TRADER_ROLE_ID;
const NACE_URL = process.env.NACE_URL || "https://nacetuin.com/";

client.once("ready", () => {
  console.log(`NACE Assistant conectat ca ${client.user.tag}`);
});

client.on("guildMemberAdd", async (member) => {
  try {
    await member.send(
      `👋 **Bine ai venit în comunitatea NACE!**\n\n` +
      `NACE este o platformă de tranzacționare crypto care oferă servicii precum Spot Trading, Futures, Copy Trading și NACE Finance.\n\n` +
      `🌐 Site oficial: ${NACE_URL}\n\n` +
      `Pentru a primi acces la rolul **Trader**, te rog să te înregistrezi pe NACE și apoi să-mi trimiți aici, în privat, **un screenshot care confirmă înregistrarea**.\n\n` +
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

    // Procesăm doar mesajele primite în DM
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

    // Verificăm dacă utilizatorul a trimis o imagine
    const image = message.attachments.find((attachment) => {
      return (
        attachment.contentType &&
        attachment.contentType.startsWith("image/")
      );
    });

    if (!image) {
      await message.reply(
        "📸 Te rog să-mi trimiți **screenshot-ul înregistrării pe NACE** ca imagine."
      );
      return;
    }

    await message.reply(
      "⏳ Am primit screenshot-ul. Îl verific acum..."
    );

    /*
      AICI vom adăuga verificarea automată cu AI a screenshot-ului.

      Pentru moment, botul primește imaginea și confirmă primirea.
      După ce configurăm verificarea AI, aici va fi:
      
      1. analizat screenshot-ul;
      2. verificat dacă dovedește înregistrarea NACE;
      3. dacă este valid -> Trader;
      4. dacă nu este valid -> cerem un screenshot mai clar.
    */

    console.log(
      `Screenshot primit de la ${message.author.tag}: ${image.url}`
    );

    // TEMPORAR: nu acordăm rolul până nu configurăm verificarea AI.
    await message.reply(
      "✅ Screenshot-ul a fost primit.\n\n" +
      "Verificarea automată este în curs de configurare. Nu este nevoie să mai trimiți nimic momentan."
    );
  } catch (error) {
    console.error("Eroare:", error);

    try {
      await message.reply(
        "❌ A apărut o eroare. Încearcă din nou mai târziu."
      );
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
