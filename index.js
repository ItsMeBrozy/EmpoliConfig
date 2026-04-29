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
    body { font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
    .code { font-size: 24px; font-weight: bold; padding: 10px; background: #f0f0f0; border-radius: 5px; margin: 10px 0; }
    button { padding: 12px 24px; font-size: 16px; background: #5865F2; color: white; border: none; border-radius: 5px; cursor: pointer; margin: 10px; }
    button:hover { background: #4752C4; }
  </style>
</head>
<body>
  <h1>🔐 Roblox Verification</h1>
  <p>Add this code to your Roblox profile description:</p>
  <div class="code">${code}</div>
  <p><strong>Step 1:</strong> <a href="https://www.roblox.com/my/account" target="_blank">Open your Roblox profile</a></p>
  <p><strong>Step 2:</strong> Add the code above to your profile description</p>
  <p><strong>Step 3:</strong> Click verify below</p>
  <button onclick="verify()">✅ Complete Verification</button>
  <div id="result"></div>
  <script>
    function verify() {
      document.getElementById('result').innerHTML = '⏳ Checking...';
      fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '${code}' }) })
        .then(res => res.json())
        .then(data => {
          document.getElementById('result').innerHTML = data.success ? '<p style="color:green">✅ ' + data.message + '</p>' : '<p style="color:red">❌ ' + data.message + '</p>';
        })
        .catch(() => { document.getElementById('result').innerHTML = '<p style="color:red">❌ Error.</p>'; });
    }
  </script>
</body>
</html>`);
});

app.post('/api/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, message: 'Invalid code.' });

  let userId = null, pending = null;
  for (const [id, data] of pendingVerifications.entries()) {
    if (data.code === code) { userId = id; pending = data; break; }
  }

  if (!pending) return res.json({ success: false, message: 'Verification not found or expired.' });
  if (Date.now() - pending.timestamp > 600000) {
    pendingVerifications.delete(userId);
    return res.json({ success: false, message: 'Code expired (10 min).' });
  }

  try {
    const profile = await getRobloxProfile(pending.robloxId);
    if (!profile || !profile.description || !profile.description.includes(code)) {
      return res.json({ success: false, message: 'Code not found in profile description.' });
    }

    try {
      const guild = client.guilds.cache.get(pending.guildId);
      if (guild) {
        const member = await guild.members.fetch(userId);
        const newNickname = `[${member.user.username} (${pending.robloxUsername})]`;
        await client.rest.put(`/guilds/${guild.id}/members/${userId}`, { body: { nick: newNickname } });
      }
    } catch (err) {
      console.error('Nickname update error:', err);
    }

    pendingVerifications.delete(userId);
    return res.json({ success: true, message: 'Verified! Nickname updated.' });
  } catch (err) {
    return res.json({ success: false, message: 'Error checking profile.' });
  }
});

app.listen(PORT, () => console.log(`🚀 Web Server running on port ${PORT}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions]
});

const TOKEN = process.env.BOT_TOKEN?.trim() || process.env.DISCORD_TOKEN?.trim();
const PREFIX = '!';
const VERIFICATION_ROLE_ID = '1447662023851638975';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const activeChecks = new Map();
const pendingVerifications = new Map();

async function getRobloxUser(username) {
  try {
    const r = await fetch(`https://users.roblox.com/v1/usernames/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json.data && json.data.length > 0 ? { Id: json.data[0].id, Username: json.data[0].name } : null;
  } catch { return null; }
}

async function getRobloxProfile(userId) {
  try {
    const r = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag} | In ${client.guilds.cache.size} guild(s)`);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isButton() && i.customId === 'verify_start') {
      const m = new ModalBuilder().setCustomId('verify_username_modal').setTitle('Roblox Verification');
      m.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('roblox_username').setLabel('Enter your Roblox username').setStyle(TextInputStyle.Short).setRequired(true)
      ));
      await i.showModal(m);
      return;
    }
    if (i.isModalSubmit() && i.customId === 'verify_username_modal') {
      await i.deferReply({ ephemeral: true });
      const username = i.fields.getTextInputValue('roblox_username');
      const data = await getRobloxUser(username);
      if (!data || !data.Id) return i.editReply({ content: '❌ Roblox user not found.' });
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      pendingVerifications.set(i.user.id, { username, robloxId: data.Id, code, timestamp: Date.now(), guildId: i.guild.id });
      try {
        await i.user.send(`🔐 **Roblox Verification**\n\n1. Add this code to your Roblox profile: **${code}**\n2. Visit: ${PUBLIC_URL}/verify?code=${code}\n3. Complete verification`);
        await i.editReply({ content: '✅ Check your DM for the verification link!' });
      } catch (err) {
        pendingVerifications.delete(i.user.id);
        await i.editReply({ content: '❌ Could not DM you. Enable DMs!' });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try { await i.reply({ content: '❌ Error processing interaction.', ephemeral: true }); } catch {}
  }
});

client.on('messageCreate', async (m) => {
  if (m.author.bot || !m.content.startsWith(PREFIX)) return;
  const args = m.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === 'verification') {
    if (!m.member.roles.cache.has(VERIFICATION_ROLE_ID)) return m.reply('❌ No permission.');
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_start').setLabel('Start Verification').setStyle(1).setEmoji('🔗'));
    await m.channel.send({ embeds: [new EmbedBuilder().setTitle('🔐 Roblox Verification').setDescription('Verify to get `[DiscordName (RobloxName)]` nickname.').addFields({ name: 'How it works', value: '1. Click button\n2. Enter Roblox username\n3. Check DM for code\n4. Add to Roblox\n5. Complete on webpage' }).setColor(0x00AE86)], components: [row] });
    return;
  }

  if (!m.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (cmd === 'activitycheck-setup') {
    const timeStr = args.join(' ');
    if (!timeStr) return m.reply('❌ Usage: `!activitycheck-setup 1 minute`');
    const ms = parseTime(timeStr);
    if (!ms || ms < 10000) return m.reply('❌ Invalid time (min 10s).');
    if (activeChecks.has(m.channel.id)) clearInterval(activeChecks.get(m.channel.id).interval);
    const interval = setInterval(async () => {
      const am = await m.channel.send({ content: `@everyone\n# Activity Check\n> ⭒━━━━━━━━━━━━━━━━━━━━⭒\n> React With : ✅\n> Ping : @everyone \n> -# Every ${timeStr}\n> ⭒━━━━━━━━━━━━━━━━━━━━⭒\n> :first_place: - *Waiting...*\n> :second_place: - *Waiting...*\n> :third_place: - *Waiting...*` }).catch(console.error);
      if (am) {
        await am.react('✅').catch(console.error);
        const reactors = [];
        const col = am.createReactionCollector({ filter: (r, u) => r.emoji.name === '✅' && !u.bot, max: 3, time: ms });
        col.on('collect', async (r, u) => {
          if (!reactors.includes(u.id)) {
            reactors.push(u.id);
            await am.edit({ content: `@everyone\n# Activity Check\n> ⭒━━━━━━━━━━━━━━━━━━━━⭒\n> React With : ✅\n> Ping : @everyone \n> -# Every ${timeStr}\n> ⭒━━━━━━━━━━━━━━━━━━━━⭒\n> :first_place: - ${reactors[0] ? `<@${reactors[0]}>` : '*Waiting...*'}\n> :second_place: - ${reactors[1] ? `<@${reactors[1]}>` : '*Waiting...*'}\n> :third_place: - ${reactors[2] ? `<@${reactors[2]}>` : '*Waiting...*'}` }).catch(console.error);
          }
        });
      }
    }, ms);
    activeChecks.set(m.channel.id, { interval, timeStr });
    await m.reply(`✅ Activity check setup! Every **${timeStr}**.`);
  }

  if (cmd === 'activitycheck-stop') {
    if (activeChecks.has(m.channel.id)) {
      clearInterval(activeChecks.get(m.channel.id).interval);
      activeChecks.delete(m.channel.id);
      await m.reply('✅ Activity check stopped.');
    } else await m.reply('❌ No active check.');
  }
});

function parseTime(s) {
  const [, v, u] = s.match(/^(\d+)\s*(minute|minutes|min|hour|hours|h|second|seconds|s)$/i) || [];
  if (!v) return null;
  const val = parseInt(v);
  return u.startsWith('s') ? val * 1000 : u.startsWith('m') ? val * 60000 : val * 3600000;
}

console.log('🔌 Connecting...');
console.log('BOT_TOKEN exists:', !!process.env.BOT_TOKEN);
console.log('DISCORD_TOKEN exists:', !!process.env.DISCORD_TOKEN);
if (TOKEN) {
  console.log('Token length:', TOKEN.length);
  console.log('Token preview:', TOKEN.substring(0, 4) + '...' + TOKEN.substring(TOKEN.length - 4));
} else {
  console.error('❌ BOT_TOKEN missing! No token found in environment variables.');
}
if (TOKEN) client.login(TOKEN).catch(e => console.error('❌ Login error:', e.message));