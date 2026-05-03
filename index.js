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

// In-memory storage for staff vs players lineups per channel
const staffLineups = new Map();
const POSITIONS = ["GK", "CB", "LB", "RB", "ST", "LST", "RST"];
const STAFF_POS = ["GK", "CB", "RB", "LB", "CM", "LW", "RW"];
const PLAY_POS = ["GK", "RB", "LB", "CDM", "CM", "LW", "RW"];

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
      // Show Roblox username modal in Discord (username box)
      const modal = new ModalBuilder()
        .setCustomId("verify_username_modal")
        .setTitle("Roblox Verification");

      const input = new TextInputBuilder()
        .setCustomId("roblox_username")
        .setLabel("Enter your Roblox username")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await i.showModal(modal);
      return;
    }

    // Slash command handler for add (staff vs players)
    if (typeof i.isChatInputCommand === 'function' && i.isChatInputCommand()) {
      if (i.commandName === 'add') {
        const team = ((i.options.getString('team') ?? 'A').toUpperCase());
        const pos = ((i.options.getString('position') ?? '').toUpperCase());
        const user = i.options.getUser('user');
        if (!user) {
          await i.reply({ content: 'Please select a user', ephemeral: true });
          return;
        }
        if (!['A','B'].includes(team)) {
          await i.reply({ content: 'Team must be A or B', ephemeral: true });
          return;
        }
        if (!POSITIONS.includes(pos)) {
          await i.reply({ content: 'Invalid position', ephemeral: true });
          return;
        }
        const channelId = i.channelId;
        if (!staffLineups.has(channelId)) {
          const empty = { GK: null, CB: null, LB: null, RB: null, ST: null, LST: null, RST: null };
          staffLineups.set(channelId, { A: { ...empty }, B: { ...empty } });
        }
        const member = await i.guild.members.fetch(user.id);
        const name = member.displayName || member.user.username;
        const data = staffLineups.get(channelId);
        data[team][pos] = name;
        await i.reply({ content: `Set ${team} ${pos} => ${name}`, ephemeral: true });
        return;
      }
    }

    if (i.isModalSubmit() && i.customId === "verify_username_modal") {
      // Process Roblox username from modal
      const inputValue = i.fields.getTextInputValue("roblox_username");
      let data = null;
      const urlMatch = inputValue.match(/https?:\/\/[^\s]+roblox\.com\/users\/(\d+)/i);
      if (urlMatch) {
        const idFromUrl = urlMatch[1];
        data = { Id: idFromUrl };
      } else {
        data = await getRobloxUser(inputValue);
      }
      if (!data || !data.Id) {
        await i.reply({ content: "Roblox user not found.", ephemeral: true });
        return;
      }

      const profile = data.Id ? await getRobloxProfile(data.Id) : null;
      const displayName = profile?.displayName ?? profile?.name ?? null;
      const canonicalName = displayName ?? inputValue;

      const code = Math.random().toString(36).substring(2, 8).toUpperCase();

      pendingVerifications.set(i.user.id, {
        robloxUsername: canonicalName,
        robloxId: data.Id,
        code: code,
        timestamp: Date.now(),
        guildId: i.guild.id
      });

      const dmContent = `🔐 Roblox Verification\n\nAdd this code to your Roblox description:\n\n${code}\n\nWhen you're ready, press Verify in this chat to complete the verification.`;
      try {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("dm_verify_confirm")
            .setLabel("Verify")
            .setStyle(ButtonStyle.Success)
        );
        await i.user.send({ content: dmContent, components: [row] });
        await i.reply({ content: "Check your DM for verification steps.", ephemeral: true });
      } catch {
        pendingVerifications.delete(i.user.id);
        await i.reply({ content: "I couldn't DM you. Enable DMs.", ephemeral: true });
      }
      return;
    }

    // DM: user clicked Verify in the account info message (perform in-Discord verification)
    if (i.isButton() && i.customId === "dm_verify_confirm") {
      try {
        const pv = pendingVerifications.get(i.user.id);
        if (!pv) {
          await i.reply({ content: "No pending verification found.", ephemeral: true });
          return;
        }
        // Verify by checking Roblox profile description for the code
        const profile = pv.robloxId ? await getRobloxProfile(pv.robloxId) : null;
        const hasCode = !!(profile?.description?.includes?.(pv.code));
        if (!hasCode) {
          await i.reply({ content: "Code not found in Roblox profile. Add the code to your profile description and try again.", ephemeral: true });
          return;
        }
        const guild = client.guilds.cache.get(pv.guildId);
        const member = await guild.members.fetch(i.user.id);
        const discordName = member.nickname ?? member.user.username;
        const nickname = `${discordName} (${pv.robloxUsername})`;
        await member.setNickname(nickname).catch(() => { });
        pendingVerifications.delete(i.user.id);
        await i.reply({ content: "Verification successful!", ephemeral: true });
      } catch {
        pendingVerifications.delete(i.user.id);
        await i.reply({ content: "Verification error.", ephemeral: true });
      }
    }

    // Cancel button (no-op in this flow)
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

  // Removed: !verification command and its UI. Verification is handled via modal/web flow only.
  // New: staffvsplayers command to manage two lineups
  if (cmd === "staffvsplayers") {
    const channelId = m.channel.id;
    if (!staffLineups.has(channelId)) {
      const emptySTAFF_A = { GK: null, CB: null, RB: null, LB: null, CM: null, LW: null, RW: null };
      const emptySTAFF_B = { GK: null, CB: null, RB: null, LB: null, CM: null, LW: null, RW: null };
      const emptyPLAY_A = { GK: null, RB: null, LB: null, CDM: null, CM: null, LW: null, RW: null };
      const emptyPLAY_B = { GK: null, RB: null, LB: null, CDM: null, CM: null, LW: null, RW: null };
      staffLineups.set(channelId, {
        STAFF: { A: { ...emptySTAFF_A }, B: { ...emptySTAFF_B } },
        PLAYERS: { A: { ...emptyPLAY_A }, B: { ...emptyPLAY_B } }
      });
    }
    const sub = (args[0] || 'show').toLowerCase();
    const data = staffLineups.get(channelId);
    if (sub === 'show') {
      const blue = "\\x1b[1;34m";
      const green = "\\x1b[1;32m";
      const reset = "\\x1b[0m";
      const staffLinesA = STAFF_POS.map(pos => `${blue}[ ${pos} ]${reset}  ${data.STAFF.A?.[pos] ?? '{@user}'}`).join("\n");
      const staffLinesB = STAFF_POS.map(pos => `${blue}[ ${pos} ]${reset}  ${data.STAFF.B?.[pos] ?? '{@user}'}`).join("\n");
      const playersLinesA = PLAY_POS.map(pos => `${green}[ ${pos} ]${reset}  ${data.PLAYERS.A?.[pos] ?? '{@user}'}`).join("\n");
      const playersLinesB = PLAY_POS.map(pos => `${green}[ ${pos} ]${reset}  ${data.PLAYERS.B?.[pos] ?? '{@user}'}`).join("\n");
      const staffBlock = `### 🛡️ STAFF FC\n\n\`\`\`ansi\n${staffLinesA}\n${staffLinesB}\n\`\`\`\n`;
      const playersBlock = `### ⚽ PLAYERS FC\n\n\`\`\`ansi\n${playersLinesA}\n${playersLinesB}\n\`\`\`\n`;
      await m.channel.send(staffBlock + "\n" + playersBlock + "\n||@everyone / @here||");
      return;
    } else if (sub === 'reset') {
      // reset both STAFF and PLAYERS for the channel
      const emptySTAFF_A = { GK: null, CB: null, RB: null, LB: null, CM: null, LW: null, RW: null };
      const emptySTAFF_B = { GK: null, CB: null, RB: null, LB: null, CM: null, LW: null, RW: null };
      const emptyPLAY_A = { GK: null, RB: null, LB: null, CDM: null, CM: null, LW: null, RW: null };
      const emptyPLAY_B = { GK: null, RB: null, LB: null, CDM: null, CM: null, LW: null, RW: null };
      staffLineups.set(channelId, {
        STAFF: { A: { ...emptySTAFF_A }, B: { ...emptySTAFF_B } },
        PLAYERS: { A: { ...emptyPLAY_A }, B: { ...emptyPLAY_B } }
      });
      await m.channel.send("Lineups reset for this channel");
      return;
    } else if (sub === 'set') {
      // usage: !staffvsplayers set A GK @Player
      const team = (args[1] || 'A').toUpperCase();
      const pos = (args[2] || '').toUpperCase();
      const member = m.mentions?.members?.first();
      if (!member) {
        await m.channel.send("Please mention a user to assign");
        return;
      }
      const name = member.displayName || member.user.username;
      if (team === 'A') {
        // STAFF.A and PLAYERS.A
        if (STAFF_POS.includes(pos)) data.STAFF.A[pos] = name;
        if (PLAY_POS.includes(pos)) data.PLAYERS.A[pos] = name;
      } else if (team === 'B') {
        // STAFF.B and PLAYERS.B
        if (STAFF_POS.includes(pos)) data.STAFF.B[pos] = name;
        if (PLAY_POS.includes(pos)) data.PLAYERS.B[pos] = name;
      } else {
        await m.channel.send("Team must be A or B");
        return;
      }
      await m.channel.send(`Set ${team} ${pos} => ${name}`);
      return;
    } else {
      await m.channel.send("Unknown staffvsplayers command. Use: !staffvsplayers show|set|reset");
      return;
    }
  }

  // Add command: !add A GK @User
  if (cmd === "add") {
    const channelId = m.channel.id;
    const team = ((args[0] || 'A').toUpperCase());
    const pos = ((args[1] || '').toUpperCase());
    let member = m.mentions?.members?.first();
    if (!member) {
      // Try to resolve by a name in brackets like [user] or {user}
      const rawName = (args.slice(2).join(' ') || '').replace(/[\[\{\}\]]/g, '').trim();
      if (rawName) {
        member = m.guild?.members.cache.find(x =>
          (x.displayName?.toLowerCase() === rawName.toLowerCase()) ||
          (x.user?.username.toLowerCase() === rawName.toLowerCase())
        );
      }
    }
    if (!['A','B'].includes(team)) {
      await m.channel.send("Team must be A or B. Example: !add A GK @User");
      return;
    }
    if (!POSITIONS.includes(pos)) {
      await m.channel.send("Invalid position. Valid: GK, CB, LB, RB, ST, LST, RST");
      return;
    }
    if (!member) {
      await m.channel.send("Please mention a user to assign");
      return;
    }
    if (!staffLineups.has(channelId)) {
      const empty = { GK: null, CB: null, LB: null, RB: null, ST: null, LST: null, RST: null };
      staffLineups.set(channelId, { A: { ...empty }, B: { ...empty } });
    }
    const data = staffLineups.get(channelId);
    const name = member.displayName || member.user.username;
    data[team][pos] = name;
    await m.channel.send(`Set ${team} ${pos} => ${name}`);
    return;
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
