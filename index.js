/**
 * DISCORD BOT - ACTIVITY CHECK
 * Prefix: !
 * Commands: !activitycheck-setup, !activitycheck-stop
 */

import express from 'express';
import https from 'node:https';
import { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits 
} from 'discord.js';
import { Agent, setGlobalDispatcher } from 'undici';

console.log('🔄 Initializing bot with DEEP TLS FIX...');

// Global undici dispatcher with high timeout
setGlobalDispatcher(new Agent({ 
  connect: { 
    timeout: 60_000 
  } 
}));

const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => res.send('Bot is Online!'));

app.listen(PORT, () => {
  console.log(`🚀 Web Server is running on port ${PORT}`);
});

// --- Discord Bot Logic ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // REQUIRED for ! commands
  ],
  // DEEP FIX: Use a dedicated HTTPS agent for the WebSocket connection
  // This often resolves the "TLS socket disconnected" error on Hugging Face
  ws: {
    agent: new https.Agent({ keepAlive: true })
  },
  rest: { timeout: 60_000 }
});

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';

if (!TOKEN) {
  console.error('❌ CRITICAL ERROR: DISCORD_TOKEN is missing!');
}

// Store active intervals: channelId -> setInterval object
const activeChecks = new Map();

client.on('ready', () => {
  console.log(`✅ SUCCESS: Logged in as ${client.user.tag}!`);
});

client.on('debug', m => console.log(`[DEBUG] ${m}`));
client.on('error', e => console.error(`[CLIENT ERROR]`, e));

client.on('messageCreate', async message => {
  // Log receipt for debugging
  console.log(`📩 Message received: "${message.content}" from ${message.author.tag}`);

  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Check for Administrator permissions
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ You need Administrator permissions.');
  }

  if (command === 'activitycheck-setup') {
    const timeStr = args.join(' ');
    
    if (!timeStr) {
      return message.reply('❌ Usage: `!activitycheck-setup 1 minute`');
    }

    const ms = parseTime(timeStr);

    if (!ms || ms < 10000) {
      return message.reply('❌ Invalid time format or too short (min 10s).');
    }

    if (activeChecks.has(message.channel.id)) {
      clearInterval(activeChecks.get(message.channel.id));
    }

    const interval = setInterval(() => {
      message.channel.send('@everyone Activity Check').catch(console.error);
    }, ms);

    activeChecks.set(message.channel.id, interval);

    await message.reply(`✅ Activity check setup! Sending every **${timeStr}** in this channel.`);
  }

  if (command === 'activitycheck-stop') {
    if (activeChecks.has(message.channel.id)) {
      clearInterval(activeChecks.get(message.channel.id));
      activeChecks.delete(message.channel.id);
      await message.reply('✅ Activity check stopped.');
    } else {
      await message.reply('❌ No active check in this channel.');
    }
  }
});

function parseTime(str) {
  const match = str.match(/^(\d+)\s*(minute|minutes|min|hour|hours|h|second|seconds|s)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('s')) return value * 1000;
  if (unit.startsWith('m')) return value * 60 * 1000;
  if (unit.startsWith('h')) return value * 60 * 60 * 1000;
  
  return null;
}

console.log('🔌 Connecting to Discord...');
client.login(TOKEN).catch(err => {
  console.error('❌ LOGIN ERROR:', err.message);
});
