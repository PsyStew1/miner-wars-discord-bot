// ============================================================
//  GRAVITATIONAL + PBS BOOST COORDINATOR BOT v2
//  Multi-server: GravitationaL clan + Psychedelic Block Smashers
//  - Saturday 9PM UTC auto-reminders to BOTH servers
//  - !boost, !ready, !go, !coord, !setup, !help in both
//  - Separate channel routing per server
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

// ── Config ────────────────────────────────────────────────────────────────────
const GRAV_CHANNEL_ID = process.env.BOOST_CHANNEL_ID || process.env.CHANNEL_ID || '';
const PBS_CHANNEL_ID  = process.env.PBS_BOOST_CHANNEL_ID || '';
const GRAV_ROLE_ID    = process.env.BOOST_ROLE_ID || '';
const PBS_ROLE_ID     = process.env.PBS_BOOST_ROLE_ID || '';
const TOKEN           = process.env.BOT_TOKEN;

if (!TOKEN) { console.error('❌  BOT_TOKEN not set!'); process.exit(1); }

const CHANNELS = [
  { id: GRAV_CHANNEL_ID, name: 'GravitationaL', roleId: GRAV_ROLE_ID, color: 0x00FF88 },
  { id: PBS_CHANNEL_ID,  name: 'Psychedelic Block Smashers', roleId: PBS_ROLE_ID, color: 0xFF00FF },
].filter(c => c.id); // only active if channel ID is set

const PREFIX = '!';

// ── State ─────────────────────────────────────────────────────────────────────
// Per-channel session state
const sessions = {}; // channelId → { active, mult, starter, readyMembers, startTime }

function getSession(channelId) {
  if (!sessions[channelId]) {
    sessions[channelId] = { active: false, mult: 'x4', starter: null, readyMembers: new Set(), startTime: null };
  }
  return sessions[channelId];
}

// Block timing state (shared)
const blockState = {
  lastBlockTime: Date.now(),
  recentIntervals: [], // last 20 block intervals in seconds
};

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getChannel(id) {
  if (!id) return null;
  try { return await client.channels.fetch(id); }
  catch (e) { console.error(`[getChannel] ${id}: ${e.message}`); return null; }
}

function timeAgo(seconds) {
  if (seconds < 60)  return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function getBlockProbs() {
  const times = blockState.recentIntervals;
  if (!times.length) return { short: 33, normal: 34, long: 33, avg: 600 };
  const avg   = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const short = Math.round(times.filter(t => t < 400).length / times.length * 100);
  const normal = Math.round(times.filter(t => t >= 400 && t < 750).length / times.length * 100);
  const long  = Math.round(times.filter(t => t >= 750).length / times.length * 100);
  return { short, normal, long, avg };
}

function getTimingAdvice() {
  const elapsed = Math.floor((Date.now() - blockState.lastBlockTime) / 1000);
  const probs = getBlockProbs();

  let phase, advice, color, emoji;

  if (elapsed < 180) {
    phase = 'Too Early'; emoji = '⏳'; color = 0x888888;
    advice = 'Block just dropped. Wait at least 3 minutes before preparing boosts.';
  } else if (elapsed < 400) {
    phase = 'Warming Up'; emoji = '👀'; color = 0xFFFF00;
    advice = 'Getting there. Monitor block timing — prepare your boosts but don\'t fire yet.';
  } else if (elapsed < 600) {
    phase = 'Good Window'; emoji = '✅'; color = 0x00FF88;
    advice = 'Solid window. Start coordinating — fire boosts in the next 2–3 minutes.';
  } else if (elapsed < 800) {
    phase = 'PRIME WINDOW'; emoji = '💎'; color = 0xFF00FF;
    advice = '**PRIME TIME** — Block is overdue. Fire boosts NOW for maximum value!';
  } else {
    phase = 'URGENT'; emoji = '🔴'; color = 0xFF0000;
    advice = '**BLOCK HEAVILY OVERDUE** — Act immediately! Every second counts.';
  }

  return { elapsed, phase, advice, color, emoji, probs };
}

// ── Strategy embeds ───────────────────────────────────────────────────────────
function buildStrategyEmbeds(serverName, color) {
  const e1 = new EmbedBuilder()
    .setColor(color)
    .setTitle(`⚡ Boost Session Strategy — ${serverName}`)
    .setDescription('Read before each session. Coordinate to maximise blocks smashed.')
    .addFields(
      { name: '📅 Session Time', value: '**Every Saturday at 9:00 PM UTC**\nSet a recurring reminder now!', inline: false },
      { name: '⏰ How to Time Your Boosts',
        value: '1️⃣  Wait for a block to drop\n2️⃣  Count ~7–10 minutes\n3️⃣  Fire boosts just before next block\n4️⃣  Use `!coord` to see live timing advice',
        inline: false },
      { name: '🎯 Boost Priority Order',
        value: '1. Clan Powerup (shared benefit)\n2. Power Up spells\n3. Echo Boost\n4. Focus Boost\n5. Instant Boost (last resort)',
        inline: false },
    )
    .setFooter({ text: `${serverName} Boost Strategy v2` });

  const e2 = new EmbedBuilder()
    .setColor(color)
    .setTitle('📋 Session Commands')
    .addFields(
      { name: '`!boost x4`', value: 'Start a session at x4 multiplier', inline: true },
      { name: '`!ready`',    value: 'Mark yourself ready to fire',       inline: true },
      { name: '`!go`',       value: 'EXECUTE — fire boosts now!',         inline: true },
      { name: '`!coord`',    value: 'Live block timing + advice',          inline: true },
      { name: '`!cancel`',   value: 'Cancel current session',              inline: true },
      { name: '`!status`',   value: 'Show session status',                 inline: true },
    )
    .setFooter({ text: 'Use these during live sessions' });

  const e3 = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎲 Multiplier Guide')
    .addFields(
      { name: 'x2 — Entry Level',    value: 'Low cost, low risk. Good for newer miners.',     inline: false },
      { name: 'x4 — Standard',       value: 'Best balance of cost vs reward. **Default.**',  inline: false },
      { name: 'x8 — High Yield',     value: 'Strong ROI window. Coordinate with clan.',      inline: false },
      { name: 'x16 — Elite',         value: 'High risk, high reward. Only in prime windows.', inline: false },
      { name: 'x32+ — Legendary',    value: 'Clan-wide coordinated push only.',               inline: false },
    )
    .setFooter({ text: 'Higher multiplier = more blocks per round' });

  return [e1, e2, e3];
}

// ── Session reminder embed ─────────────────────────────────────────────────────
function buildReminderEmbed(serverName, color, roleId, minutesUntil) {
  const pingText = roleId ? `<@&${roleId}>` : '@everyone';
  const isNow = minutesUntil === 0;

  return {
    content: isNow
      ? `${pingText} 🚨 **BOOST SESSION IS STARTING NOW!**`
      : `${pingText} ⏰ Boost session in **${minutesUntil} minutes!**`,
    embed: new EmbedBuilder()
      .setColor(isNow ? 0xFF0000 : color)
      .setTitle(isNow ? `🔥 BOOST SESSION — ${serverName} — LIVE NOW!` : `⏰ Reminder — ${minutesUntil}min to Boost Session`)
      .setDescription(
        isNow
          ? `**Everyone online? Type \`!boost x4\` to start!**\nUse \`!ready\` then \`!go\` when timed correctly.`
          : `Get ready! Session starts at **9:00 PM UTC**.\nType \`!coord\` for live timing when it begins.`
      )
      .addFields(
        { name: '📅 Schedule', value: 'Every Saturday 9:00 PM UTC', inline: true },
        { name: '⚡ Start Command', value: '`!boost x4`', inline: true },
      )
      .setFooter({ text: `${serverName} • Coordinated boost for max blocks` })
      .setTimestamp(),
  };
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdBoost(message, args, cfgChannel) {
  const mult = args[0] || 'x4';
  const sess = getSession(message.channelId);
  sess.active = true;
  sess.mult = mult;
  sess.starter = message.author.username;
  sess.startTime = Date.now();
  sess.readyMembers = new Set([message.author.id]);

  const embed = new EmbedBuilder()
    .setColor(cfgChannel?.color || 0xFF00FF)
    .setTitle(`🚀 BOOST SESSION STARTED — ${mult.toUpperCase()}`)
    .setDescription(`**${message.author.username}** kicked off a boost session!\n\nType \`!ready\` to join, then wait for \`!go\``)
    .addFields(
      { name: '⚡ Multiplier',  value: `**${mult}**`,                                 inline: true },
      { name: '👥 Ready',       value: `**1** member`,                                 inline: true },
      { name: '⏱ Started',     value: `<t:${Math.floor(Date.now()/1000)}:R>`,         inline: true },
    )
    .setFooter({ text: cfgChannel?.name || 'Boost Session' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

async function cmdReady(message) {
  const sess = getSession(message.channelId);
  if (!sess.active) return message.reply('❌ No active session. Start one with `!boost x4`');
  sess.readyMembers.add(message.author.id);
  await message.reply(`✅ **${message.author.username}** is ready! **${sess.readyMembers.size}** total ready.`);
}

async function cmdGo(message) {
  const sess = getSession(message.channelId);
  if (!sess.active) return message.reply('❌ No active session.');
  const timing = getTimingAdvice();

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🔥🔥🔥 BOOST NOW — FIRE FIRE FIRE!')
    .setDescription(`**ALL ${sess.readyMembers.size} PLAYERS — ACTIVATE BOOST NOW!**\n\nMultiplier: **${sess.mult}**`)
    .addFields(
      { name: '👥 Players Boosting', value: sess.readyMembers.size > 0 ? `${sess.readyMembers.size} members` : 'Solo', inline: true },
      { name: '⏱ Block Status',     value: `${timing.emoji} ${timing.phase} (${timeAgo(timing.elapsed)})`, inline: true },
    )
    .setTimestamp();

  await message.channel.send({ content: '@here', embeds: [embed] });
  sess.active = false;
  sess.readyMembers = new Set();
}

async function cmdCancel(message) {
  const sess = getSession(message.channelId);
  sess.active = false;
  sess.readyMembers = new Set();
  await message.reply('🛑 Boost session cancelled.');
}

async function cmdStatus(message) {
  const sess = getSession(message.channelId);
  if (!sess.active) return message.reply('No active session. Use `!boost x4` to start.');

  const elapsed = Math.floor((Date.now() - sess.startTime) / 1000);
  const embed = new EmbedBuilder()
    .setColor(0x00FFFF)
    .setTitle('📊 Session Status')
    .addFields(
      { name: '⚡ Multiplier', value: sess.mult,                              inline: true },
      { name: '👤 Started by', value: sess.starter,                           inline: true },
      { name: '⏱ Running for', value: timeAgo(elapsed),                       inline: true },
      { name: '👥 Ready Members', value: `${sess.readyMembers.size} members`, inline: true },
    )
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

async function cmdCoord(message, cfgChannel) {
  const t = getTimingAdvice();
  const embed = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(`${t.emoji} Boost Coordinator — ${t.phase}`)
    .setDescription(t.advice)
    .addFields(
      { name: '⏱ Elapsed',       value: timeAgo(t.elapsed),                                                 inline: true },
      { name: '📊 Avg Block',     value: `~${Math.round(t.probs.avg)}s`,                                    inline: true },
      { name: '⚡ Session',        value: getSession(message.channelId).active ? '🟢 Active' : '⚪ None',   inline: true },
      { name: '🎲 Block Probabilities',
        value: `Short (<400s): **${t.probs.short}%**  |  Normal: **${t.probs.normal}%**  |  Long (>750s): **${t.probs.long}%**`,
        inline: false },
    )
    .setFooter({ text: (cfgChannel?.name || 'Boost Bot') + ' • Data from last 20 blocks' })
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

async function cmdSetup(message, cfgChannel) {
  const embeds = buildStrategyEmbeds(cfgChannel?.name || 'Clan', cfgChannel?.color || 0xFF00FF);
  for (const embed of embeds) {
    const msg = await message.channel.send({ embeds: [embed] });
    try { await msg.pin(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  await message.reply('✅ Strategy embeds posted and pinned!');
}

async function cmdHelp(message, cfgChannel) {
  const embed = new EmbedBuilder()
    .setColor(cfgChannel?.color || 0xFF00FF)
    .setTitle(`⛏ Boost Coordinator — ${cfgChannel?.name || 'Clan'}`)
    .setDescription('Commands for boost session coordination:')
    .addFields(
      { name: '`!boost <mult>`', value: 'Start a session (e.g. `!boost x4`, `!boost x8`)', inline: false },
      { name: '`!ready`',        value: 'Join the active session',                           inline: false },
      { name: '`!go`',           value: '🔥 Execute — everyone fires NOW',                  inline: false },
      { name: '`!cancel`',       value: 'Cancel the current session',                        inline: false },
      { name: '`!status`',       value: 'Show who\'s ready in current session',              inline: false },
      { name: '`!coord`',        value: 'Live block timing + boost advice',                  inline: false },
      { name: '`!setup`',        value: 'Post & pin strategy guides (officers only)',        inline: false },
      { name: '`!help`',         value: 'This message',                                      inline: false },
    )
    .setFooter({ text: 'Sessions run Saturdays 9PM UTC' });
  await message.reply({ embeds: [embed] });
}

// ── Message handler ───────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  // Find which configured channel this came from (or allow any)
  const cfgChannel = CHANNELS.find(c => c.id === message.channelId) || null;

  const [command, ...args] = message.content.slice(PREFIX.length).trim().toLowerCase().split(/\s+/);
  const rawArgs = message.content.slice(PREFIX.length).trim().split(/\s+/).slice(1);

  console.log(`[${cfgChannel?.name || message.guild?.name || 'Unknown'}] ${message.author.username}: !${command}`);

  try {
    switch (command) {
      case 'boost':  await cmdBoost(message, rawArgs, cfgChannel);  break;
      case 'ready':  await cmdReady(message);                        break;
      case 'go':     await cmdGo(message);                           break;
      case 'cancel': await cmdCancel(message);                       break;
      case 'status': await cmdStatus(message);                       break;
      case 'coord':  await cmdCoord(message, cfgChannel);            break;
      case 'setup':  await cmdSetup(message, cfgChannel);            break;
      case 'help':   await cmdHelp(message, cfgChannel);             break;
    }
  } catch (e) {
    console.error(`Error in !${command}:`, e.message);
    try { await message.reply(`⚠️ Error: ${e.message}`); } catch {}
  }
});

// ── Scheduled Saturday reminders ─────────────────────────────────────────────
// Runs at 8:00, 8:30, 8:55, and 9:00 PM UTC every Saturday
const reminderSchedules = [
  { cron: '0 20 * * 6',  minutes: 60 },   // 8:00 PM UTC — 60min warning
  { cron: '30 20 * * 6', minutes: 30 },   // 8:30 PM UTC — 30min warning
  { cron: '55 20 * * 6', minutes: 5  },   // 8:55 PM UTC — 5min warning
  { cron: '0 21 * * 6',  minutes: 0  },   // 9:00 PM UTC — GO TIME
];

for (const schedule of reminderSchedules) {
  cron.schedule(schedule.cron, async () => {
    console.log(`[Scheduler] Firing ${schedule.minutes === 0 ? 'BOOST NOW' : schedule.minutes + 'min'} reminder`);
    for (const cfgCh of CHANNELS) {
      const ch = await getChannel(cfgCh.id);
      if (!ch) continue;
      const { content, embed } = buildReminderEmbed(cfgCh.name, cfgCh.color, cfgCh.roleId, schedule.minutes);
      try {
        await ch.send({ content, embeds: [embed] });
        console.log(`  ✅ Reminder sent to ${cfgCh.name}`);
      } catch (e) {
        console.error(`  ❌ Failed to send to ${cfgCh.name}: ${e.message}`);
      }
    }
  }, { timezone: 'UTC' });
}

// ── Simulated block detection (update lastBlockTime when you hook a real source) ──
setInterval(() => {
  const elapsed = Date.now() - blockState.lastBlockTime;
  // Average BTC block ~10min — simulate for timing advisor
  if (elapsed > 600000 + Math.random() * 300000) {
    const intervalSec = Math.floor(elapsed / 1000);
    blockState.recentIntervals.push(intervalSec);
    if (blockState.recentIntervals.length > 20) blockState.recentIntervals.shift();
    blockState.lastBlockTime = Date.now();
    console.log(`[Block] Simulated block — interval: ${intervalSec}s`);
  }
}, 30000);

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log('================================================');
  console.log(`  Boost Coordinator Bot v2 — MULTI-SERVER`);
  console.log(`  Logged in as: ${client.user.tag}`);
  console.log('================================================');
  if (CHANNELS.length === 0) {
    console.warn('  ⚠  No channels configured! Set BOOST_CHANNEL_ID and/or PBS_BOOST_CHANNEL_ID');
  }
  for (const c of CHANNELS) {
    console.log(`  ✅  ${c.name}: #${c.id}`);
  }
  console.log('------------------------------------------------');
  console.log('  📅 Saturday reminders: 60min, 30min, 5min, GO');
  console.log('================================================');
  client.user.setActivity('⚡ Coordinating Boosts', { type: 0 });
});

client.on('error', e => console.error('[Error]', e.message));
process.on('unhandledRejection', e => console.error('[Unhandled]', e?.message));

client.login(TOKEN);
