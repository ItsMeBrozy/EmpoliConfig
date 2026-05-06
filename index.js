import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, ButtonStyle, ButtonBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, ModalBuilder, PermissionFlagsBits, EmbedBuilder, Partials } from 'discord.js';
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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const PREFIX = "!";
const VERIFICATION_ROLE_ID = "1447662023851638975";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// In-memory storage for staff vs players lineups per channel
const staffLineups = new Map();
const lineupMessages = new Map();

const ALLOWED_ROLES = ["1447662023851638975", "1489650850916733129"];
let activeCheckMessageId = null;
let activeCheckWinners = [];
let activityInterval = null;
let currentActivityChannelId = "1485778074275680490";

function getActivityCheckContent(winners = []) {
  const p1 = winners[0] ? `<@${winners[0]}>` : "@user";
  const p2 = winners[1] ? `<@${winners[1]}>` : "@user";
  const p3 = winners[2] ? `<@${winners[2]}>` : "@user";

  return `@everyone
# ⚽ Steinbrücke's Activity Check! ⚽
> ⭒━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⭒
> React With : ✅
> Ping : @everyone 
> -# Every 24h
> ⭒━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⭒
> 
> 🥇 -  ${p1}
> 
> 🥈 - ${p2}
> 
> 🥉 - ${p3} `;
}

async function sendActivityCheck(channelId) {
  try {
    const targetId = channelId || currentActivityChannelId;
    const channel = await client.channels.fetch(targetId);
    if (!channel) return;
    
    activeCheckWinners = [];
    const content = getActivityCheckContent(activeCheckWinners);
    const msg = await channel.send(content);
    await msg.react("✅").catch(err => console.error("Reaction failed:", err));
    activeCheckMessageId = msg.id;
  } catch (e) {
    console.error("Failed to send activity check:", e);
  }
}

const POSITIONS = ["GK", "CB", "LB", "RB", "ST", "LST", "RST"];
const STAFF_POS = ["GK", "CB", "RB", "LB", "CM", "LW", "RW"];
const PLAY_POS = ["GK", "RB", "LB", "CDM", "CM", "LW", "RW"];

function renderLineupsA(data) {
  const staff = STAFF_POS.map(pos => `[ ${pos} ]  ${data.STAFF.A?.[pos] ?? '{user}'}`).join("\n");
  const players = PLAY_POS.map(pos => `[ ${pos} ]  ${data.PLAYERS.A?.[pos] ?? '{user}'}`).join("\n");
  return `### STAFF FC - A\n${staff}\n\n### PLAYERS FC - A\n${players}`;
}

async function updateLineupMessage(channel, data) {
  const channelId = channel.id;
  const content = renderLineupsA(data);
  if (lineupMessages.has(channelId)) {
    try {
      const msg = await channel.messages.fetch(lineupMessages.get(channelId));
      await msg.edit(content);
      return;
    } catch { }
  }
  const sent = await channel.send(content);
  lineupMessages.set(channelId, sent.id);
}

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

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.id !== activeCheckMessageId) return;
  if (reaction.emoji.name !== "✅") return;
  
  if (activeCheckWinners.includes(user.id)) return;
  if (activeCheckWinners.length >= 3) return;
  
  activeCheckWinners.push(user.id);
  
  try {
    const newContent = getActivityCheckContent(activeCheckWinners);
    await reaction.message.edit(newContent);
  } catch (e) {
    console.error("Failed to update activity check winners:", e);
  }
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

      if (i.commandName === 'start') {
        const hasRole = i.member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
        if (!hasRole) {
          await i.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
          return;
        }

        const timeStr = i.options.getString('time');
        const channelId = i.options.getString('channel');
        const ms = parseDuration(timeStr);

        if (!ms) {
          await i.reply({ content: "❌ Invalid time format.", ephemeral: true });
          return;
        }

        if (activityInterval) clearInterval(activityInterval);
        currentActivityChannelId = channelId;

        activityInterval = setInterval(() => {
          sendActivityCheck(currentActivityChannelId);
        }, ms);

        await i.reply({ content: `✅ **Activity Check Loop Started!** Interval: ${timeStr}, Channel: <#${channelId}>.`, ephemeral: true });
        await sendActivityCheck(currentActivityChannelId);
        return;
      }

      if (i.commandName === 'stop') {
        const hasRole = i.member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
        if (!hasRole) {
          await i.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
          return;
        }

        if (activityInterval) {
          clearInterval(activityInterval);
          activityInterval = null;
          await i.reply({ content: "🛑 Activity check loop has been stopped.", ephemeral: true });
        } else {
          await i.reply({ content: "❌ No active activity check loop is running.", ephemeral: true });
        }
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

  // staffvsplayers command to manage two lineups
  if (cmd === "staffvsplayers") {
    const channelId = m.channel.id;
    const sub = (args[0] || 'show').toLowerCase();
    
    if (sub === 'show' || sub === 'reset') {
      // Reset both STAFF and PLAYERS for the channel to ensure "new text so no names in it"
      const emptySTAFF_A = { GK: null, CB: null, RB: null, LB: null, CM: null, LW: null, RW: null };
      const emptyPLAY_A = { GK: null, RB: null, LB: null, CDM: null, CM: null, LW: null, RW: null };
      
      staffLineups.set(channelId, {
        STAFF: { A: { ...emptySTAFF_A } },
        PLAYERS: { A: { ...emptyPLAY_A } }
      });
      
      const data = staffLineups.get(channelId);
      const content = renderLineupsA(data);
      const sent = await m.channel.send(content);
      lineupMessages.set(channelId, sent.id);
      return;
    } else {
      await m.channel.send("Unknown command. Use: !staffvsplayers show|reset");
      return;
    }
  }

  // STM command: !stm @user A/B position
  if (cmd === "stm") {
    const channelId = m.channel.id;
    const member = m.mentions?.members?.first();
    const team = (args[1] || '').toUpperCase();
    const pos = (args[2] || '').toUpperCase();

    if (!member) {
      await m.channel.send("Please mention a user. Usage: !stm @user A/B position");
      return;
    }
    if (!['A', 'B'].includes(team)) {
      await m.channel.send("Team must be A (Staff) or B (Players).");
      return;
    }
    if (!STAFF_POS.includes(pos) && !PLAY_POS.includes(pos)) {
      await m.channel.send("Invalid position.");
      return;
    }
    if (!staffLineups.has(channelId)) {
      await m.channel.send("Please run !staffvsplayers first to initialize.");
      return;
    }

    const data = staffLineups.get(channelId);
    const name = `<@${member.id}>`;

    if (team === 'A') {
      if (!STAFF_POS.includes(pos)) {
        await m.channel.send(`Position ${pos} is not valid for STAFF (Team A).`);
        return;
      }
      data.STAFF.A[pos] = name;
    } else {
      if (!PLAY_POS.includes(pos)) {
        await m.channel.send(`Position ${pos} is not valid for PLAYERS (Team B).`);
        return;
      }
      data.PLAYERS.A[pos] = name;
    }
    
    await m.channel.send(`Set Team ${team} ${pos} => ${name}`);
    await updateLineupMessage(m.channel, data);
    return;
  }

  // Remove command: !remove @user
  if (cmd === "remove") {
    const channelId = m.channel.id;
    const member = m.mentions?.members?.first();
    if (!member) {
      await m.channel.send("Please mention a user to remove.");
      return;
    }
    if (!staffLineups.has(channelId)) {
      await m.channel.send("No lineup initialized for this channel yet.");
      return;
    }

    const data = staffLineups.get(channelId);
    const targetPing = `<@${member.id}>`;
    let found = false;

    // Search and remove from STAFF
    for (const pos in data.STAFF.A) {
      if (data.STAFF.A[pos] === targetPing) {
        data.STAFF.A[pos] = null;
        found = true;
      }
    }
    // Search and remove from PLAYERS
    for (const pos in data.PLAYERS.A) {
      if (data.PLAYERS.A[pos] === targetPing) {
        data.PLAYERS.A[pos] = null;
        found = true;
      }
    }

    if (found) {
      await m.channel.send(`Removed ${targetPing} from all positions.`);
      await updateLineupMessage(m.channel, data);
    } else {
      await m.channel.send(`${targetPing} was not found in the lineup.`);
    }
    return;
  }

  // Activity Check Control Commands
  if (cmd === "start") {
    const hasRole = m.member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
    if (!hasRole) return m.channel.send("❌ You do not have permission to use this command.");

    const timeStr = args[0] || "24h";
    const ms = parseDuration(timeStr);
    
    if (!ms) {
      return m.channel.send("❌ Invalid time format. Use e.g. `!start 10s`, `!start 30m`, `!start 1h`, `!start 1d`.");
    }

    // Channel selection: !start 24h #channel
    let targetChannelId = currentActivityChannelId;
    if (args[1]) {
      const match = args[1].match(/<#(\d+)>/);
      targetChannelId = match ? match[1] : args[1];
    }

    if (activityInterval) clearInterval(activityInterval);
    currentActivityChannelId = targetChannelId;

    activityInterval = setInterval(() => {
      sendActivityCheck(currentActivityChannelId);
    }, ms);

    await m.channel.send(`✅ **Activity Check Loop Started!** It will now post every **${timeStr}** in <#${currentActivityChannelId}>. Sending the first one now...`);
    await sendActivityCheck(currentActivityChannelId);
    return;
  }

  if (cmd === "stop") {
    const hasRole = m.member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
    if (!hasRole) return m.channel.send("❌ You do not have permission to use this command.");

    if (activityInterval) {
      clearInterval(activityInterval);
      activityInterval = null;
      await m.channel.send("🛑 Activity check loop has been stopped.");
    } else {
      await m.channel.send("❌ No active activity check loop is running.");
    }
    return;
  }

  if (cmd === "activitycheck") {
    const hasRole = m.member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
    if (!hasRole) return m.channel.send("❌ You do not have permission to use this command.");

    await m.channel.send("Sending activity check to the dedicated channel...");
    await sendActivityCheck();
    return;
  }

  if (cmd === "sync") {
    const commands = [
      {
        name: 'stop',
        description: 'Stop the 24h activity check loop'
      },
      {
        name: 'add',
        description: 'Add a player to the lineup',
        options: [
          { name: 'user', type: 6, description: 'User to add', required: true },
          { name: 'team', type: 3, description: 'Team A or B', required: true },
          { name: 'position', type: 3, description: 'Position (e.g. GK, ST)', required: true }
        ]
      }
    ];

    try {
      await m.guild.commands.set(commands);
      await m.channel.send("✅ Slash commands synced for this server! (Try typing `/` now)");
    } catch (e) {
      console.error(e);
      await m.channel.send("❌ Failed to sync commands. Make sure the bot has `applications.commands` scope and administrator permissions.");
    }
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

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return num * 1000;
  if (unit === 'm') return num * 60000;
  if (unit === 'h') return num * 3600000;
  if (unit === 'd') return num * 86400000;
  return null;
}
