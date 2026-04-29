import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, ButtonStyle, ButtonBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, ModalBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ connect: { timeout: 60000 } }));

const app = express();
const PORT = process.env.PORT || 7860;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Bot is Online!'));

app.get('/verify', (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Invalid verification link.');

  res.send(`<!DOCTYPE html>
<html>
<head>
<title>Roblox Verification</title>
<style>
body { font-family: Arial; max-width:600px; margin:50px auto; text-align:center; }
.code { font-size:24px; font-weight:bold; padding:10px; background:#f0f0f0; border-radius:5px; margin:10px 0; }
button { padding:12px 24px; font-size:16px; background:#5865F2; color:white; border:none; border-radius:5px; cursor:pointer; }
</style>
</head>
<body>

<h1>🔐 Roblox Verification</h1>

<p>Add this code to your Roblox profile description:</p>
<div class="code">${code}</div>

<p><a href="https://www.roblox.com/my/account" target="_blank">Open Roblox profile</a></p>

<button onclick="verify()">Complete Verification</button>

<div id="result"></div>

  <script>
function verify(){
 document.getElementById("result").innerHTML="Checking...";

  fetch("/api/verify",{
    method:"POST",
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({code:"${code}"})
  })
  .then(r=>r.json())
  .then(d=>{
    if(d.success){
      document.getElementById("result").innerHTML="<p style='color:green'>"+d.message+"</p>";
    }else{
      document.getElementById("result").innerHTML="<p style='color:red'>"+d.message+"</p>";
    }
  })
}
</script>

</body>
</html>`);
});

// Convenience: support /verify/:code as an alternative to query parameter
app.get('/verify/:code', (req, res) => {
  const code = req.params.code;
  if (!code) return res.send('Invalid verification link.');
  res.redirect(`/verify?code=${code}`);
});

const pendingVerifications = new Map();

app.post('/api/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, message: "Invalid code." });

  let userId = null;
  let pending = null;

  for (const [id, data] of pendingVerifications.entries()) {
    if (data.code === code) {
      userId = id;
      pending = data;
      break;
    }
  }

  if (!pending) return res.json({ success: false, message: "Verification expired." });

  try {
    // Current flow: we consider verification complete once the code matches.
    const guild = client.guilds.cache.get(pending.guildId);
    const member = await guild.members.fetch(userId);
    const discordName = member.nickname ?? member.user.username;
    const nickname = `${discordName} (${pending.robloxUsername})`;
    await member.setNickname(nickname).catch(() => { });

    pendingVerifications.delete(userId);
    return res.json({ success: true, message: "Verified successfully!" });
  } catch (e) {
    console.error(e);
    return res.json({ success: false, message: "Verification error." });
  }
});

app.listen(PORT, () => console.log("Web server running on " + PORT));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const PREFIX = "!";
const VERIFICATION_ROLE_ID = "1447662023851638975";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

async function getRobloxUser(username) {
  try {
    const r = await fetch(`https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(username)}`);
    // Some Roblox responses may still return 200 with a body indicating not found
    if (!r.ok) {
      return null;
    }

    const dataRaw = await r.json().catch(() => null);
    const data = Array.isArray(dataRaw)
      ? (dataRaw.length > 0 ? ({
          ...dataRaw[0],
          Id: dataRaw[0].Id ?? dataRaw[0].id ?? null
        }) : null)
      : dataRaw;
    if (!data) return null;

    // Roblox may return the ID under different keys depending on API version
    const id = data.Id ?? data.id ?? null;
    if (!id) return null;

    // Normalize to always expose Id for downstream logic
    return { ...data, Id: id };
  } catch {
    return null;
  }
}

async function getRobloxProfile(id) {
  try {
    const r = await fetch(`https://users.roblox.com/v1/users/${id}`);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

client.on("ready", () => {
  console.log("Logged in as " + client.user.tag);
});

client.on("interactionCreate", async i => {

  try {

    if (i.isButton() && i.customId === "verify_start") {
      // Web-based verification only; do not DM. Generate a code and present the link publicly.
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      pendingVerifications.set(i.user.id, {
        code,
        timestamp: Date.now(),
        guildId: i.guild.id
      });
      try {
        await i.reply(`Verification link: ${PUBLIC_URL}/verify?code=${code}`);
      } catch {
        await i.editReply("Could not send verification link in chat.");
      }
      return;
    }

    if (i.isModalSubmit() && i.customId === "verify_username_modal") {
      // Modal-based flow is deprecated; acknowledge promptly to avoid interaction timeout
      try {
        await i.reply({ content: "Verification via web is required. Please use the link sent in DM.", ephemeral: true });
      } catch {
        // ignore if already replied
      }
    }

    // Public verification flow (no DM interactions)
    if (i.isButton() && i.customId === "dm_verify_confirm") {
      // Ignore DM-based confirmation in this redesigned flow
      try {
        await i.reply({ content: "Verification is handled via the web link. Please use the URL sent in chat.", ephemeral: true });
      } catch {}
    }

    // Cancel button (no-op in public flow)
    if (i.isButton() && i.customId === "dm_verify_cancel") {
      try {
        await i.reply({ content: "Verification canceled.", ephemeral: true });
      } catch {}
    }

  } catch (e) {
    console.error("Interaction error:", e);
    try {
      if (i.deferred || i.replied) {
        await i.editReply({ content: "❌ Something went wrong." });
      } else {
        await i.reply({ content: "❌ Something went wrong.", ephemeral: true });
      }
    } catch {}
  }

});

client.on("messageCreate", async m => {

  if (m.author.bot) return;
  if (!m.content.startsWith(PREFIX)) return;

  const args = m.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === "verification") {

    if (!m.member.roles.cache.has(VERIFICATION_ROLE_ID))
      return m.reply("No permission.");

    const button = new ButtonBuilder()
      .setCustomId("verify_start")
      .setLabel("Start Verification")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔗");

    const row = new ActionRowBuilder().addComponents(button);

    const embed = new EmbedBuilder()
      .setTitle("Roblox Verification")
      .setDescription("Press the button below to verify your Roblox account.")
      .setColor(0x00AE86);

    m.channel.send({ embeds: [embed], components: [row] });

  }

});

console.log("Connecting bot...");
console.log("BOT_TOKEN exists:", !!process.env.BOT_TOKEN);
console.log("DISCORD_TOKEN exists:", !!process.env.DISCORD_TOKEN);
if (TOKEN) {
  console.log("Token length:", TOKEN.length);
  console.log("Token preview:", TOKEN.substring(0, 4) + "..." + TOKEN.substring(TOKEN.length - 4));
} else {
  console.error("❌ No token found! Set BOT_TOKEN or DISCORD_TOKEN in Railway variables.");
}
if (TOKEN) client.login(TOKEN).catch(e => console.error("Login error:", e.message));
