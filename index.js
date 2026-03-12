// ============================================================
//  MINER WARS BOT v6  —  Multi-Server Edition
//  Supports: GravitationaL clan + Psychedelic Block Smashers
//  Commands work in any server the bot is in.
//  Each server gets its own channel routing + role names.
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ── Environment ───────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;

// GravitationaL server channel IDs (existing setup)
const GRAV = {
  guildId:     process.env.GRAV_GUILD_ID     || '',
  commands:    process.env.COMMANDS_CHANNEL_ID  || process.env.CHANNEL_ID || '',
  block:       process.env.BLOCK_CHANNEL_ID     || '',
  price:       process.env.PRICE_CHANNEL_ID     || '',
  boost:       process.env.BOOST_CHANNEL_ID     || '',
  spells:      process.env.SPELLS_CHANNEL_ID    || '',
  marketplace: process.env.MARKETPLACE_CHANNEL_ID || '',
};

// PBS server channel IDs
const PBS = {
  guildId:     process.env.PBS_GUILD_ID        || '',
  commands:    process.env.PBS_COMMANDS_ID      || '',   // #clan-chat or #smash-talk
  boost:       process.env.PBS_BOOST_ID         || '',   // #boost-coordination
  stats:       process.env.PBS_STATS_ID         || '',   // #stats-flex
  price:       process.env.PBS_PRICE_ID         || '',   // #btc-price-alerts
  announce:    process.env.PBS_ANNOUNCE_ID      || '',   // #announcements
  verify:      process.env.PBS_VERIFY_ID        || '',   // #join-apply
};

// ── Per-server config ─────────────────────────────────────────────────────────
function getServerConfig(guildId) {
  if (guildId === GRAV.guildId || (!PBS.guildId && !GRAV.guildId)) {
    return { name: 'GravitationaL', channels: GRAV, isPBS: false };
  }
  if (guildId === PBS.guildId) {
    return { name: 'Psychedelic Block Smashers', channels: PBS, isPBS: true };
  }
  // Unknown server — use PBS config as fallback if GRAV not set
  return { name: 'Unknown Server', channels: PBS.guildId ? PBS : GRAV, isPBS: false };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sendToChannel(channelId, embed, content = null) {
  if (!channelId) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    const payload = { embeds: [embed] };
    if (content) payload.content = content;
    return await ch.send(payload);
  } catch (e) {
    console.error(`[sendToChannel] Failed for ${channelId}:`, e.message);
    return null;
  }
}

function colourBar(pct, length = 20) {
  const filled = Math.round(pct / 100 * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function timeAgo(seconds) {
  if (seconds < 60)  return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

// ── Price fetching ────────────────────────────────────────────────────────────
let priceCache = { btc: null, gmt: null, lastFetch: 0 };

async function fetchPrices() {
  const now = Date.now();
  if (now - priceCache.lastFetch < 60000) return priceCache;
  try {
    const https = require('https');
    const data = await new Promise((res, rej) => {
      https.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,gomining-token&vs_currencies=usd&include_24hr_change=true',
        (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => res(JSON.parse(d)));
        }
      ).on('error', rej);
    });
    priceCache = {
      btc: data.bitcoin?.usd,
      btcChange: data.bitcoin?.usd_24h_change,
      gmt: data['gomining-token']?.usd,
      gmtChange: data['gomining-token']?.usd_24h_change,
      lastFetch: now,
    };
  } catch (e) {
    console.error('[fetchPrices]', e.message);
  }
  return priceCache;
}

// ── Block timing ──────────────────────────────────────────────────────────────
let blockState = {
  lastBlockTime: Date.now(),
  blockCount: 0,
  recentTimes: [],    // last 20 block intervals
  weeklyBlocks: 0,
  cycleStart: Date.now(),
};

function getBlockStats() {
  const elapsed = Math.floor((Date.now() - blockState.lastBlockTime) / 1000);
  const avg = blockState.recentTimes.length
    ? blockState.recentTimes.reduce((a, b) => a + b, 0) / blockState.recentTimes.length
    : 600;

  let status, statusEmoji;
  if (elapsed < 300)      { status = 'Recent';   statusEmoji = '🟢'; }
  else if (elapsed < 600) { status = 'Normal';   statusEmoji = '🟡'; }
  else if (elapsed < 900) { status = 'Overdue';  statusEmoji = '🟠'; }
  else                    { status = 'Very Late'; statusEmoji = '🔴'; }

  const shortPct  = Math.round(blockState.recentTimes.filter(t => t < 400).length / Math.max(1, blockState.recentTimes.length) * 100);
  const normalPct = Math.round(blockState.recentTimes.filter(t => t >= 400 && t < 750).length / Math.max(1, blockState.recentTimes.length) * 100);
  const longPct   = Math.round(blockState.recentTimes.filter(t => t >= 750).length / Math.max(1, blockState.recentTimes.length) * 100);

  return { elapsed, avg, status, statusEmoji, shortPct, normalPct, longPct };
}

// ── Command handlers ──────────────────────────────────────────────────────────

// !block / !smash — block timing
async function cmdBlock(message, cfg) {
  const stats = getBlockStats();
  const embed = new EmbedBuilder()
    .setColor(stats.elapsed > 600 ? 0xFF4444 : stats.elapsed > 300 ? 0xFFAA00 : 0x00FF88)
    .setTitle(`${stats.statusEmoji} Block Status — ${cfg.name}`)
    .addFields(
      { name: '⏱  Time Since Last Block', value: `**${timeAgo(stats.elapsed)}**`, inline: true },
      { name: '📊 Average Interval',       value: `**${Math.round(stats.avg)}s**`,  inline: true },
      { name: '🟢 Status',                  value: `**${stats.status}**`,            inline: true },
      { name: '⚡ Block Probabilities (last 20)',
        value: `Short (<400s): **${stats.shortPct}%**\nNormal: **${stats.normalPct}%**\nLong (>750s): **${stats.longPct}%**`,
        inline: false },
      { name: '📦 Weekly Blocks',
        value: `**${blockState.weeklyBlocks}** / ~1,008 this cycle`,
        inline: true },
    )
    .setFooter({ text: cfg.isPBS ? '⛏ Psychedelic Block Smashers' : '⛏ GravitationaL Clan' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });

  // Cross-post to block channel if different from source
  const targetId = cfg.isPBS ? cfg.channels.stats : cfg.channels.block;
  if (targetId && targetId !== message.channelId) {
    await sendToChannel(targetId, embed);
  }
}

// !price — BTC + GMT prices
async function cmdPrice(message, cfg) {
  const prices = await fetchPrices();
  const embed = new EmbedBuilder()
    .setColor(0xF7931A)
    .setTitle('💰 Live Prices')
    .addFields(
      {
        name: '₿ Bitcoin (BTC)',
        value: prices.btc
          ? `**$${prices.btc.toLocaleString()}**\n${prices.btcChange > 0 ? '📈' : '📉'} ${prices.btcChange?.toFixed(2)}% (24h)`
          : 'Unavailable',
        inline: true,
      },
      {
        name: '⛏ GoMining (GMT)',
        value: prices.gmt
          ? `**$${prices.gmt.toFixed(4)}**\n${prices.gmtChange > 0 ? '📈' : '📉'} ${prices.gmtChange?.toFixed(2)}% (24h)`
          : 'Unavailable',
        inline: true,
      },
    )
    .setFooter({ text: 'CoinGecko • cached 60s' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });

  const targetId = cfg.isPBS ? cfg.channels.price : cfg.channels.price;
  if (targetId && targetId !== message.channelId) {
    await sendToChannel(targetId, embed);
  }
}

// !spell — spell recommendation
async function cmdSpell(message, cfg) {
  const stats = getBlockStats();
  let recommendation, color, reasoning;

  if (stats.elapsed < 180) {
    recommendation = '⏳ WAIT — Block just dropped';
    color = 0xAAAAAA;
    reasoning = 'Too early to cast. Wait for better timing.';
  } else if (stats.elapsed < 420) {
    recommendation = '🔮 NORMAL CAST — Good timing';
    color = 0x00FF88;
    reasoning = `${stats.elapsed}s elapsed — solid window for standard spells.`;
  } else if (stats.elapsed < 700) {
    recommendation = '💎 POWER CAST — Ideal window!';
    color = 0xFF00FF;
    reasoning = `${stats.elapsed}s elapsed — sweet spot for high-value spells.`;
  } else {
    recommendation = '🔴 URGENT — Cast NOW before block drops!';
    color = 0xFF4444;
    reasoning = `${stats.elapsed}s elapsed — block overdue. Cast immediately!`;
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('✨ Spell Recommendation')
    .setDescription(`**${recommendation}**\n\n${reasoning}`)
    .addFields(
      { name: '⏱ Elapsed',  value: `${timeAgo(stats.elapsed)}`,           inline: true },
      { name: '📊 Avg',      value: `${Math.round(stats.avg)}s`,           inline: true },
      { name: '⚡ Status',   value: `${stats.statusEmoji} ${stats.status}`, inline: true },
    )
    .setFooter({ text: cfg.name })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  if (!cfg.isPBS && cfg.channels.spells && cfg.channels.spells !== message.channelId) {
    await sendToChannel(cfg.channels.spells, embed);
  }
}

// !boost — boost coordination
const boostSession = { active: false, participants: [], startTime: null, level: 'x4' };

async function cmdBoost(message, args, cfg) {
  const level = args[0] || 'x4';
  boostSession.active = true;
  boostSession.participants = [message.author.username];
  boostSession.startTime = Date.now();
  boostSession.level = level;

  const embed = new EmbedBuilder()
    .setColor(0xFF00FF)
    .setTitle(`⚡ BOOST SESSION STARTED — ${level.toUpperCase()}`)
    .setDescription(`**${message.author.username}** has started a boost session!\n\nType \`!ready\` to join, then \`!go\` to execute.`)
    .addFields(
      { name: '🚀 Boost Level', value: `**${level}**`,        inline: true },
      { name: '👥 Participants', value: '1 so far',           inline: true },
      { name: '⏱ Started',      value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true },
    )
    .setFooter({ text: cfg.name + ' • Saturdays 9PM UTC' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  const targetId = cfg.isPBS ? cfg.channels.boost : cfg.channels.boost;
  if (targetId && targetId !== message.channelId) {
    await sendToChannel(targetId, embed, cfg.isPBS ? '@everyone 🌈⛏ BOOST SESSION — JOIN NOW!' : null);
  }
}

// !ready
async function cmdReady(message, cfg) {
  if (!boostSession.active) {
    return message.reply('❌  No active boost session. Use `!boost x4` to start one.');
  }
  if (!boostSession.participants.includes(message.author.username)) {
    boostSession.participants.push(message.author.username);
  }
  const embed = new EmbedBuilder()
    .setColor(0x00FF88)
    .setTitle('✅ Player Ready!')
    .setDescription(`**${message.author.username}** is ready to boost!`)
    .addFields({ name: '👥 Ready Players', value: boostSession.participants.join(', ') })
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// !go
async function cmdGo(message, cfg) {
  if (!boostSession.active) {
    return message.reply('❌  No active boost session.');
  }
  const embed = new EmbedBuilder()
    .setColor(0xFF00FF)
    .setTitle('🚀 BOOST — EXECUTE NOW!')
    .setDescription(`**ALL PLAYERS — ACTIVATE BOOST NOW!**\n\nLevel: **${boostSession.level}**`)
    .addFields({ name: '👥 Players Boosting', value: boostSession.participants.join(', ') || 'Solo' })
    .setTimestamp();
  await message.channel.send({ content: '@here', embeds: [embed] });
  boostSession.active = false;
  boostSession.participants = [];
}

// !roi <investment> <efficiency>
async function cmdROI(message, args) {
  const invest    = parseFloat(args[0]);
  const efficiency = parseFloat(args[1]);
  if (!invest || !efficiency) {
    return message.reply('Usage: `!roi <investment_usd> <w_per_th>` — e.g. `!roi 100 8`');
  }
  const prices = await fetchPrices();
  const thPerDollar = 1 / 0.05; // rough estimate
  const estimatedTH = invest * thPerDollar;
  const dailyBTC    = estimatedTH * 0.0000001;
  const dailyUSD    = prices.btc ? dailyBTC * prices.btc : null;
  const monthlyUSD  = dailyUSD ? dailyUSD * 30 : null;
  const yearsROI    = monthlyUSD ? (invest / (monthlyUSD * 12)).toFixed(1) : '?';

  const embed = new EmbedBuilder()
    .setColor(0xF7931A)
    .setTitle('📊 ROI Calculator')
    .addFields(
      { name: '💵 Investment',     value: `$${invest}`,                       inline: true },
      { name: '⚡ Efficiency',     value: `${efficiency} W/TH`,               inline: true },
      { name: '⛏ Est. Hashrate',  value: `${estimatedTH.toFixed(0)} TH/s`, inline: true },
      { name: '₿ Daily Est.',     value: dailyUSD ? `$${dailyUSD.toFixed(2)} / day` : 'N/A', inline: true },
      { name: '📅 Monthly Est.',  value: monthlyUSD ? `$${monthlyUSD.toFixed(2)} / mo` : 'N/A', inline: true },
      { name: '📈 Est. ROI',      value: `~${yearsROI} years`, inline: true },
    )
    .setFooter({ text: 'Estimates only — actual results vary' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// !coord — timing advisor
async function cmdCoord(message, cfg) {
  const stats = getBlockStats();
  const nextBoostEst = Math.max(0, Math.round(stats.avg) - stats.elapsed);

  let advice, color;
  if (stats.elapsed < 200) {
    advice = '⏳ Too early — block just dropped. Wait at least 5 minutes.';
    color = 0xAAAAAA;
  } else if (stats.elapsed < 400) {
    advice = '👀 Monitor — block likely within 5–7 minutes.';
    color = 0xFFFF00;
  } else if (stats.elapsed < 600) {
    advice = '✅ Good window — prepare your boosts now.';
    color = 0x00FF88;
  } else if (stats.elapsed < 800) {
    advice = '⚡ PRIME WINDOW — boost now for maximum value!';
    color = 0xFF00FF;
  } else {
    advice = '🔴 URGENT — block heavily overdue. Act immediately!';
    color = 0xFF0000;
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎯 Boost Timing Advisor')
    .setDescription(advice)
    .addFields(
      { name: '⏱ Elapsed',          value: timeAgo(stats.elapsed),              inline: true },
      { name: '📊 Avg Interval',     value: `${Math.round(stats.avg)}s`,         inline: true },
      { name: '⏰ Next est.',         value: nextBoostEst > 0 ? `~${nextBoostEst}s` : 'NOW', inline: true },
      { name: '⚡ Block Trends',
        value: `Short: ${stats.shortPct}% | Normal: ${stats.normalPct}% | Long: ${stats.longPct}%`,
        inline: false },
    )
    .setFooter({ text: cfg.name })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// !verify — PBS only: post a verification request
async function cmdVerify(message, args, cfg) {
  if (!cfg.isPBS) {
    return message.reply('This command is only available in the PBS server.');
  }
  const info = args.join(' ');
  if (!info) {
    return message.reply('Usage: `!verify <your GoMining username> <your TH/s>` — e.g. `!verify PsyStew 29`');
  }

  const embed = new EmbedBuilder()
    .setColor(0xFF00FF)
    .setTitle('🎟 Verification Request')
    .setDescription(`**${message.author.username}** wants to join the PBS clan!`)
    .addFields(
      { name: '📋 Info Provided', value: info },
      { name: '📅 Requested',     value: `<t:${Math.floor(Date.now()/1000)}:F>` },
    )
    .setFooter({ text: 'Psychedelic Block Smashers — An officer will verify shortly' });

  await message.reply('✅ Verification request sent to officers!');

  if (cfg.channels.verify && cfg.channels.verify !== message.channelId) {
    await sendToChannel(cfg.channels.verify, embed,
      `👋 New member request from ${message.author}!`);
  }
  if (cfg.channels.announce) {
    // Post a welcome notice
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x00FF88)
      .setTitle('🌱 New Member Request!')
      .setDescription(`${message.author} has applied to join PBS! Officers check #join-apply.`)
      .setTimestamp();
    await sendToChannel(cfg.channels.announce, welcomeEmbed);
  }
}

// !stats — server stats + your TH/s leaderboard stub
async function cmdStats(message, cfg) {
  const guild = message.guild;
  const embed = new EmbedBuilder()
    .setColor(cfg.isPBS ? 0xFF00FF : 0x00FF88)
    .setTitle(`📊 ${cfg.name} Stats`)
    .setDescription('Here\'s a quick snapshot of the clan:')
    .addFields(
      { name: '👥 Members',    value: `${guild.memberCount}`,          inline: true },
      { name: '🟢 Online',     value: `${guild.approximatePresenceCount || '?'}`, inline: true },
      { name: '⛏ Min TH/s',   value: cfg.isPBS ? '20 TH/s' : 'Varies', inline: true },
      { name: '📋 Ref Code',   value: '`A6JOY04`',                    inline: true },
      { name: '⏰ Boost Time', value: 'Saturdays 9PM UTC',            inline: true },
    )
    .setFooter({ text: 'Use !roi to calculate earnings' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// !channels — show channel config for current server
async function cmdChannels(message, cfg) {
  const ch = cfg.channels;
  const lines = cfg.isPBS ? [
    `Commands:   ${ch.commands  ? `<#${ch.commands}>`  : 'not set'}`,
    `Boost:      ${ch.boost     ? `<#${ch.boost}>`     : 'not set'}`,
    `Stats:      ${ch.stats     ? `<#${ch.stats}>`     : 'not set'}`,
    `Price:      ${ch.price     ? `<#${ch.price}>`     : 'not set'}`,
    `Announce:   ${ch.announce  ? `<#${ch.announce}>`  : 'not set'}`,
    `Verify:     ${ch.verify    ? `<#${ch.verify}>`    : 'not set'}`,
  ] : [
    `Commands:   ${ch.commands    ? `<#${ch.commands}>`    : 'not set'}`,
    `Block:      ${ch.block       ? `<#${ch.block}>`       : 'not set'}`,
    `Price:      ${ch.price       ? `<#${ch.price}>`       : 'not set'}`,
    `Boost:      ${ch.boost       ? `<#${ch.boost}>`       : 'not set'}`,
    `Spells:     ${ch.spells      ? `<#${ch.spells}>`      : 'not set'}`,
    `Marketplace:${ch.marketplace ? `<#${ch.marketplace}>` : 'not set'}`,
  ];

  const embed = new EmbedBuilder()
    .setColor(0x00FFFF)
    .setTitle(`⚙️ Channel Config — ${cfg.name}`)
    .setDescription('```\n' + lines.join('\n') + '\n```')
    .setFooter({ text: 'Set missing channels via Railway environment variables' });
  await message.reply({ embeds: [embed] });
}

// !help — commands list
async function cmdHelp(message, cfg) {
  const baseCommands = `
\`!block\`  / \`!smash\`  — Block timing & status
\`!price\`             — BTC + GMT prices
\`!spell\`             — Spell cast recommendation
\`!coord\`             — Boost timing advisor
\`!boost <level>\`     — Start a boost session (e.g. \`!boost x4\`)
\`!ready\`             — Join active boost session
\`!go\`                — Execute the boost now
\`!roi <usd> <w/th>\`  — ROI calculator (e.g. \`!roi 100 8\`)
\`!stats\`             — Server & clan stats
\`!channels\`          — Show channel config
\`!help\`              — This message
  `.trim();

  const pbsExtra = cfg.isPBS ? `\n\`!verify <username> <th/s>\`  — Submit join request` : '';

  const embed = new EmbedBuilder()
    .setColor(cfg.isPBS ? 0xFF00FF : 0x00FF88)
    .setTitle(`⛏ ${cfg.name} — Bot Commands`)
    .setDescription(baseCommands + pbsExtra)
    .setFooter({ text: `v6.0 Multi-Server • ${cfg.name}` });
  await message.reply({ embeds: [embed] });
}

// ── Message handler ───────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const cfg = getServerConfig(message.guild?.id);
  const [command, ...args] = message.content.slice(1).trim().toLowerCase().split(/\s+/);
  const rawArgs = message.content.slice(1).trim().split(/\s+/).slice(1);

  console.log(`[${cfg.name}] ${message.author.username}: !${command}`);

  try {
    switch (command) {
      case 'block':
      case 'smash':    await cmdBlock(message, cfg);           break;
      case 'price':    await cmdPrice(message, cfg);           break;
      case 'spell':    await cmdSpell(message, cfg);           break;
      case 'coord':    await cmdCoord(message, cfg);           break;
      case 'boost':    await cmdBoost(message, rawArgs, cfg);  break;
      case 'ready':    await cmdReady(message, cfg);           break;
      case 'go':       await cmdGo(message, cfg);              break;
      case 'roi':      await cmdROI(message, rawArgs);         break;
      case 'stats':    await cmdStats(message, cfg);           break;
      case 'channels': await cmdChannels(message, cfg);        break;
      case 'verify':   await cmdVerify(message, rawArgs, cfg); break;
      case 'help':     await cmdHelp(message, cfg);            break;
      default: break;
    }
  } catch (e) {
    console.error(`[${cfg.name}] Error in !${command}:`, e.message);
    try {
      await message.reply(`⚠️ Error running \`!${command}\`: ${e.message}`);
    } catch {}
  }
});

// ── Auto block timer (updates every 30s) ─────────────────────────────────────
setInterval(() => {
  // Simulate block arrival detection — in production hook this to
  // GoMining API or webhook to get real block times
  const timeSinceLast = Date.now() - blockState.lastBlockTime;
  if (timeSinceLast > 600000 + Math.random() * 300000) {
    const interval = Math.floor(timeSinceLast / 1000);
    blockState.recentTimes.push(interval);
    if (blockState.recentTimes.length > 20) blockState.recentTimes.shift();
    blockState.lastBlockTime = Date.now();
    blockState.blockCount++;
    blockState.weeklyBlocks++;
    console.log(`[Block] New block detected! Interval: ${interval}s`);
  }
}, 30000);

// ── Hourly price update to all servers ───────────────────────────────────────
setInterval(async () => {
  const prices = await fetchPrices();
  if (!prices.btc) return;

  const embed = new EmbedBuilder()
    .setColor(0xF7931A)
    .setTitle('💰 Hourly Price Update')
    .addFields(
      { name: '₿ BTC',  value: `$${prices.btc?.toLocaleString() || 'N/A'}`, inline: true },
      { name: '⛏ GMT',  value: `$${prices.gmt?.toFixed(4) || 'N/A'}`,      inline: true },
    )
    .setTimestamp();

  // Post to all configured price channels
  const channels = [GRAV.price, PBS.price].filter(Boolean);
  for (const chId of channels) {
    await sendToChannel(chId, embed);
  }
}, 3600000);

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log('============================================');
  console.log(`  Miner Wars Bot v6 — MULTI-SERVER EDITION`);
  console.log(`  Logged in as: ${client.user.tag}`);
  console.log('============================================');

  const servers = client.guilds.cache.map(g => g.name).join(', ');
  console.log(`  Active in: ${servers || 'No servers yet'}`);
  console.log('--------------------------------------------');

  console.log('  GravitationaL channels:');
  console.log(`    Commands:    ${GRAV.commands    || 'NOT SET'}`);
  console.log(`    Block:       ${GRAV.block       || 'NOT SET'}`);
  console.log(`    Price:       ${GRAV.price       || 'NOT SET'}`);
  console.log(`    Boost:       ${GRAV.boost       || 'NOT SET'}`);
  console.log('--------------------------------------------');
  console.log('  PBS channels:');
  console.log(`    Commands:    ${PBS.commands     || 'NOT SET'}`);
  console.log(`    Boost:       ${PBS.boost        || 'NOT SET'}`);
  console.log(`    Stats:       ${PBS.stats        || 'NOT SET'}`);
  console.log(`    Price:       ${PBS.price        || 'NOT SET'}`);
  console.log(`    Verify:      ${PBS.verify       || 'NOT SET'}`);
  console.log('============================================');

  client.user.setActivity('⛏ Smashing Blocks', { type: 0 });
});

client.on('error', e => console.error('[Client Error]', e.message));
process.on('unhandledRejection', e => console.error('[Unhandled]', e.message));

if (!TOKEN) {
  console.error('❌  BOT_TOKEN / DISCORD_TOKEN not set!');
  process.exit(1);
}

client.login(TOKEN);
