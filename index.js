// ============================================================
//  MINER WARS BOT v6.1  —  Multi-Server Edition
//  Supports: GravitationaL clan + Psychedelic Block Smashers
//  Commands work in any server the bot is in.
//  Each server gets its own channel routing + role names.
//  v6.1: Prediction Engine v2 — WebSocket live blocks,
//        exponential distribution math, auto-alerts + 1.5min followup
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const WebSocket_Mempool = require('ws');

// ── Prediction Engine v2 — Constants & State ─────────────────────────────────
const BLOCK_SAMPLE_SIZE  = 50;
const LAMBDA_WINDOW      = 20;
const TREND_WINDOW       = 10;
const SHORT_THRESHOLD    = 7;
const LONG_THRESHOLD     = 14;
const FOLLOWUP_DELAY_MS  = 90 * 1000;
const ALERT_CHANNEL_ID   = process.env.ALERT_CHANNEL_ID || '1467365522185129984';

let blockStore = {
  blocks: [], lastFetch: 0, wsConnected: false, wsInstance: null,
};
let mempoolStore = {
  firstBlockFeeRate: null, firstBlockTxCount: null, mempoolSizeTxs: null,
};
let alertStore = {
  lastAlertedHeight: null, followUpTimer: null,
};

// ── Discord client ────────────────────────────────────────────────────────────
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

// GravitationaL server channel IDs
const GRAV = {
  guildId:     process.env.GRAV_GUILD_ID        || '',
  commands:    process.env.COMMANDS_CHANNEL_ID  || process.env.CHANNEL_ID || '',
  block:       process.env.BLOCK_CHANNEL_ID     || '',
  price:       process.env.PRICE_CHANNEL_ID     || '',
  boost:       process.env.BOOST_CHANNEL_ID     || '',
  spells:      process.env.SPELLS_CHANNEL_ID    || '',
  marketplace: process.env.MARKETPLACE_CHANNEL_ID || '',
};

// PBS server channel IDs
const PBS = {
  guildId:  process.env.PBS_GUILD_ID    || '',
  commands: process.env.PBS_COMMANDS_ID || '',
  boost:    process.env.PBS_BOOST_ID    || '',
  stats:    process.env.PBS_STATS_ID    || '',
  price:    process.env.PBS_PRICE_ID    || '',
  announce: process.env.PBS_ANNOUNCE_ID || '',
  verify:   process.env.PBS_VERIFY_ID   || '',
};

// ── Per-server config ─────────────────────────────────────────────────────────
function getServerConfig(guildId) {
  if (guildId === GRAV.guildId || (!PBS.guildId && !GRAV.guildId)) {
    return { name: 'GravitationaL', channels: GRAV, isPBS: false };
  }
  if (guildId === PBS.guildId) {
    return { name: 'Psychedelic Block Smashers', channels: PBS, isPBS: true };
  }
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
  if (seconds < 60)   return `${seconds}s ago`;
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
      btc:       data.bitcoin?.usd,
      btcChange: data.bitcoin?.usd_24h_change,
      gmt:       data['gomining-token']?.usd,
      gmtChange: data['gomining-token']?.usd_24h_change,
      lastFetch: now,
    };
  } catch (e) {
    console.error('[fetchPrices]', e.message);
  }
  return priceCache;
}

// ── Block timing (legacy — used by !block, !spell) ────────────────────────────
let blockState = {
  lastBlockTime: Date.now(),
  blockCount: 0,
  recentTimes: [],
  weeklyBlocks: 0,
  cycleStart: Date.now(),
};

function getBlockStats() {
  const elapsed = Math.floor((Date.now() - blockState.lastBlockTime) / 1000);
  const avg = blockState.recentTimes.length
    ? blockState.recentTimes.reduce((a, b) => a + b, 0) / blockState.recentTimes.length
    : 600;

  let status, statusEmoji;
  if (elapsed < 300)      { status = 'Recent';    statusEmoji = '🟢'; }
  else if (elapsed < 600) { status = 'Normal';    statusEmoji = '🟡'; }
  else if (elapsed < 900) { status = 'Overdue';   statusEmoji = '🟠'; }
  else                    { status = 'Very Late'; statusEmoji = '🔴'; }

  const shortPct  = Math.round(blockState.recentTimes.filter(t => t < 400).length / Math.max(1, blockState.recentTimes.length) * 100);
  const normalPct = Math.round(blockState.recentTimes.filter(t => t >= 400 && t < 750).length / Math.max(1, blockState.recentTimes.length) * 100);
  const longPct   = Math.round(blockState.recentTimes.filter(t => t >= 750).length / Math.max(1, blockState.recentTimes.length) * 100);

  return { elapsed, avg, status, statusEmoji, shortPct, normalPct, longPct };
}

// ── Prediction Engine v2 — Block fetching ────────────────────────────────────
async function getRecentBlocks(count = BLOCK_SAMPLE_SIZE) {
  const cacheAge = Date.now() - blockStore.lastFetch;
  if (blockStore.blocks.length >= count && cacheAge < 120000) {
    return blockStore.blocks.slice(0, count);
  }
  try {
    let allBlocks = [];
    let lastHeight = null;
    const pagesNeeded = Math.ceil(count / 15);

    for (let page = 0; page < pagesNeeded; page++) {
      const url = lastHeight
        ? `https://mempool.space/api/v1/blocks/${lastHeight - 1}`
        : 'https://mempool.space/api/v1/blocks';

      const https = require('https');
      const pageBlocks = await new Promise((res, rej) => {
        https.get(url, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { res([]); } });
        }).on('error', () => res([]));
      });

      if (!pageBlocks?.length) break;
      allBlocks = [...allBlocks, ...pageBlocks];
      lastHeight = pageBlocks[pageBlocks.length - 1].height;

      if (page < pagesNeeded - 1) {
        await new Promise(r => setTimeout(r, 350));
      }
    }

    if (allBlocks.length > 0) {
      blockStore.blocks    = allBlocks.slice(0, 60);
      blockStore.lastFetch = Date.now();
      console.log(`[Blocks] Fetched ${allBlocks.length} blocks via REST`);
    }
    return blockStore.blocks.slice(0, count);
  } catch (e) {
    console.warn('[Blocks] REST fetch failed, using cache:', e.message);
    return blockStore.blocks.slice(0, count);
  }
}

// ── Prediction Engine v2 — Deep analysis ─────────────────────────────────────
//
//  MATH: Bitcoin block intervals follow an Exponential Distribution (Poisson process).
//  If λ = mean block time in minutes, then:
//    P(interval < t)     = 1 - e^(-t/λ)   → probability of a short block
//    P(interval > t)     = e^(-t/λ)        → probability of a long block
//    P(block in next Xm) = 1 - e^(-X/λ)   → forward probability
//
//  This is far more accurate than simple counting on a small sample.
//
function deepBlockAnalysis(blocks) {
  if (!blocks || blocks.length < 3) return null;

  const intervals = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const diff = (blocks[i].timestamp - blocks[i + 1].timestamp) / 60;
    if (diff > 0 && diff < 120) intervals.push(diff);
  }
  if (intervals.length < 2) return null;

  // Window averages
  const w10  = intervals.slice(0, Math.min(TREND_WINDOW,  intervals.length));
  const w20  = intervals.slice(0, Math.min(LAMBDA_WINDOW, intervals.length));
  const w50  = intervals.slice(0, Math.min(50,            intervals.length));
  const avg10 = w10.reduce((a, b) => a + b, 0) / w10.length;
  const avg20 = w20.reduce((a, b) => a + b, 0) / w20.length; // λ
  const avg50 = w50.reduce((a, b) => a + b, 0) / w50.length;

  // Exponential distribution probabilities
  const λ = avg20;
  const pShort_raw  = (1 - Math.exp(-SHORT_THRESHOLD / λ)) * 100;
  const pLong_raw   = Math.exp(-LONG_THRESHOLD / λ)         * 100;
  const pShort      = Math.round(pShort_raw);
  const pLong       = Math.round(pLong_raw);
  const pNormal     = 100 - pShort - pLong;

  // Forward probabilities (memoryless — same regardless of wait so far)
  const pNext5  = Math.round((1 - Math.exp(-5  / λ)) * 100);
  const pNext10 = Math.round((1 - Math.exp(-10 / λ)) * 100);
  const pNext15 = Math.round((1 - Math.exp(-15 / λ)) * 100);

  // Trend — compare recent 10-block avg vs 50-block baseline
  const trendRatio = avg10 / avg50;
  const trend = trendRatio < 0.90 ? 'ACCELERATING'
              : trendRatio > 1.10 ? 'DECELERATING'
              : 'STABLE';
  const trendPct = ((trendRatio - 1) * 100).toFixed(1);

  // Streak detection
  let fastStreak = 0, slowStreak = 0;
  for (const t of intervals.slice(0, 6)) {
    if (t < SHORT_THRESHOLD) fastStreak++; else break;
  }
  for (const t of intervals.slice(0, 6)) {
    if (t > LONG_THRESHOLD)  slowStreak++; else break;
  }

  // Current block age in minutes
  const currentBlockAge = (Date.now() / 1000 - blocks[0].timestamp) / 60;

  // Hashrate estimate: difficulty × 2³² / avg_block_time_seconds → EH/s
  let hashrateEH = null;
  if (blocks[0]?.difficulty) {
    const avgSec  = avg20 * 60;
    const rawHash = (blocks[0].difficulty * Math.pow(2, 32)) / avgSec;
    hashrateEH = (rawHash / 1e18).toFixed(1);
  }

  // Difficulty epoch
  const height          = blocks[0]?.height || 0;
  const epochPosition   = height % 2016;
  const epochRemaining  = 2016 - epochPosition;
  const epochPct        = Math.round((epochPosition / 2016) * 100);
  const epochActualTime = epochPosition * avg50;
  const epochTargetTime = epochPosition * 10;
  let difficultyTrend   = 'STABLE';
  let difficultyChangePct = 0;
  if (epochPosition > 100) {
    difficultyChangePct = ((epochTargetTime - epochActualTime) / epochTargetTime) * 100;
    difficultyTrend = difficultyChangePct > 2  ? 'INCREASE (blocks too fast)'
                    : difficultyChangePct < -2 ? 'DECREASE (blocks too slow)'
                    : 'STABLE';
  }

  return {
    pShort, pNormal, pLong,
    sampleSize: intervals.length,
    lambda: avg20.toFixed(2),
    avg10: avg10.toFixed(1),
    avg20: avg20.toFixed(1),
    avg50: avg50.toFixed(1),
    trend, trendPct,
    fastStreak, slowStreak,
    currentBlockAge: currentBlockAge.toFixed(1),
    pNext5, pNext10, pNext15,
    hashrateEH,
    blockHeight: height,
    epochPosition, epochRemaining, epochPct,
    difficultyTrend,
    difficultyChangePct: Math.abs(difficultyChangePct).toFixed(1),
  };
}

// ── Prediction Engine v2 — WebSocket manager ─────────────────────────────────
function initBlockWebSocket() {
  console.log('[WS] Connecting to mempool.space...');
  const ws = new WebSocket_Mempool('wss://mempool.space/api/v1/ws');
  blockStore.wsInstance = ws;

  ws.on('open', () => {
    console.log('[WS] Connected ✓');
    blockStore.wsConnected = true;
    ws.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] }));
    ws._pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket_Mempool.OPEN) ws.ping();
    }, 30000);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // New block
      if (msg.block) {
        const newBlock = msg.block;
        console.log(`[WS] New block #${newBlock.height}`);

        // Update in-memory cache
        blockStore.blocks    = [newBlock, ...blockStore.blocks].slice(0, 60);
        blockStore.lastFetch = Date.now();

        // Update legacy blockState too so !block / !spell stay accurate
        const nowMs = Date.now();
        const interval = Math.floor((nowMs - blockState.lastBlockTime) / 1000);
        if (interval > 0) {
          blockState.recentTimes.push(interval);
          if (blockState.recentTimes.length > 20) blockState.recentTimes.shift();
        }
        blockState.lastBlockTime = nowMs;
        blockState.blockCount++;
        blockState.weeklyBlocks++;

        // Fire alerts — once per height
        if (alertStore.lastAlertedHeight !== newBlock.height) {
          alertStore.lastAlertedHeight = newBlock.height;
          if (alertStore.followUpTimer) {
            clearTimeout(alertStore.followUpTimer);
            alertStore.followUpTimer = null;
          }
          await sendBlockAlert(newBlock, 'immediate').catch(console.error);
          alertStore.followUpTimer = setTimeout(async () => {
            await sendBlockAlert(newBlock, 'followup').catch(console.error);
          }, FOLLOWUP_DELAY_MS);
        }
      }

      // Mempool fee pressure
      if (msg['mempool-blocks']?.[0]) {
        const nextBlock = msg['mempool-blocks'][0];
        mempoolStore.firstBlockFeeRate = nextBlock.medianFee;
        mempoolStore.firstBlockTxCount = nextBlock.nTx;
      }

      // Network stats
      if (msg.mempoolInfo) {
        mempoolStore.mempoolSizeTxs = msg.mempoolInfo.size;
      }

    } catch (e) {
      console.warn('[WS] Message parse error:', e.message);
    }
  });

  ws.on('pong', () => {});

  ws.on('close', (code) => {
    console.warn(`[WS] Disconnected (code ${code}) — reconnecting in 15s`);
    blockStore.wsConnected = false;
    clearInterval(ws._pingInterval);
    setTimeout(initBlockWebSocket, 15000);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    ws.terminate();
  });
}

// ── Prediction Engine v2 — Auto alert sender ─────────────────────────────────
async function sendBlockAlert(block, type) {
  const channel = client.channels.cache.get(ALERT_CHANNEL_ID);
  if (!channel) {
    console.warn('[Alert] Channel not found:', ALERT_CHANNEL_ID);
    return;
  }

  const analysis    = deepBlockAnalysis(blockStore.blocks);
  const blockAgeNow = ((Date.now() / 1000 - block.timestamp) / 60).toFixed(1);

  if (type === 'immediate') {
    const feeInfo = mempoolStore.firstBlockFeeRate
      ? `${mempoolStore.firstBlockFeeRate.toFixed(0)} sat/vB`
      : 'Unknown';

    const embed = new EmbedBuilder()
      .setColor(0x10B981)
      .setTitle(`⛏️ NEW BLOCK #${block.height.toLocaleString()}`)
      .setDescription('**🚀 ACTION WINDOW OPEN — Go hard NOW!**\nEarly boosts compound the most. Full clan coordination optimal.')
      .setTimestamp();

    embed.addFields(
      { name: '⏱️ Block Age',    value: `${blockAgeNow} min`,                        inline: true },
      { name: '📦 Transactions', value: (block.tx_count || 0).toLocaleString(),       inline: true },
      { name: '💸 Next Fee',     value: feeInfo,                                      inline: true },
    );

    if (analysis) {
      embed.addFields(
        { name: '🎯 P(Short <7min)',  value: `**${analysis.pShort}%**`,  inline: true },
        { name: '🎯 P(Normal 7-14)', value: `**${analysis.pNormal}%**`, inline: true },
        { name: '🎯 P(Long >14min)', value: `**${analysis.pLong}%**`,   inline: true },
        { name: '📈 Trend',
          value: `${analysis.trend} · 10-blk: ${analysis.avg10}min · 50-blk: ${analysis.avg50}min`,
          inline: false },
      );
      if (analysis.fastStreak >= 2)
        embed.addFields({ name: '⚡ Fast Streak!', value: `${analysis.fastStreak} fast blocks in a row — high multiplier conditions!`, inline: false });
      if (analysis.slowStreak >= 2)
        embed.addFields({ name: '🐢 Slow Streak', value: `${analysis.slowStreak} slow blocks in a row`, inline: false });
    }

    embed.setFooter({ text: `📬 1.5-min deep analysis incoming • ${analysis?.sampleSize || '?'} blocks sampled • λ=${analysis?.lambda || '?'}min` });
    await channel.send({ embeds: [embed] });
    console.log(`[Alert] Immediate sent for block #${block.height}`);

  } else if (type === 'followup') {
    const currentAge = parseFloat(blockAgeNow);
    let phaseColor, phaseTitle, phaseAdvice;

    if (currentAge < 3) {
      phaseColor = 0x10B981; phaseTitle = '🔥 STILL PRIME WINDOW';
      phaseAdvice = 'Keep boosting hard — red turbos + rockets still highly effective';
    } else if (currentAge < 6) {
      phaseColor = 0x22C55E; phaseTitle = '🟢 GOOD WINDOW';
      phaseAdvice = 'Purple / Red boosts still viable — coordinate with clan';
    } else if (currentAge < 10) {
      phaseColor = 0xF59E0B; phaseTitle = '🟡 CAUTION ZONE';
      phaseAdvice = 'Shield existing gains — light boosts only — save big spells';
    } else {
      phaseColor = 0xEF4444; phaseTitle = '🔴 LATE ROUND — DEFEND';
      phaseAdvice = 'No new boosts — protect position — next block incoming soon';
    }

    let pressureLabel = '❓ Unknown';
    if (mempoolStore.firstBlockFeeRate != null) {
      const fee = mempoolStore.firstBlockFeeRate;
      pressureLabel = fee > 80 ? `🔴 HIGH (${fee.toFixed(0)} sat/vB)`
                    : fee > 30 ? `🟡 MEDIUM (${fee.toFixed(0)} sat/vB)`
                    :            `🟢 LOW (${fee.toFixed(0)} sat/vB)`;
    }

    const embed = new EmbedBuilder()
      .setColor(phaseColor)
      .setTitle(`📊 Block #${block.height} · 1.5-Min Deep Analysis`)
      .setDescription(`**${phaseTitle}** · ${blockAgeNow} min elapsed\n${phaseAdvice}`)
      .setTimestamp();

    if (analysis) {
      embed.addFields(
        { name: '⏳ P(block in 5min)',  value: `${analysis.pNext5}%`,  inline: true },
        { name: '⏳ P(block in 10min)', value: `${analysis.pNext10}%`, inline: true },
        { name: '⏳ P(block in 15min)', value: `${analysis.pNext15}%`, inline: true },

        { name: '🎯 Short (<7min)',     value: `${analysis.pShort}%`,  inline: true },
        { name: '🎯 Normal (7-14min)',  value: `${analysis.pNormal}%`, inline: true },
        { name: '🎯 Long (>14min)',     value: `${analysis.pLong}%`,   inline: true },

        { name: '📈 Speed Trend',
          value: `${analysis.trend} · Recent: ${analysis.avg10}min · Baseline: ${analysis.avg50}min`,
          inline: false },

        { name: '💸 Mempool Pressure', value: pressureLabel,                                             inline: true },
        { name: '🔢 Sample Size',       value: `${analysis.sampleSize} blocks (λ=${analysis.lambda}min)`, inline: true },

        { name: '⚙️ Difficulty Epoch',
          value: `${analysis.epochPct}% through epoch\n${analysis.epochRemaining} blocks until adjustment\nEstimate: ${analysis.difficultyTrend}`,
          inline: false },
      );
      if (analysis.hashrateEH)
        embed.addFields({ name: '💪 Est. Hashrate', value: `${analysis.hashrateEH} EH/s`, inline: true });
      if (analysis.fastStreak >= 2)
        embed.addFields({ name: '⚡ Fast Streak!', value: `${analysis.fastStreak} consecutive fast blocks`, inline: false });
      if (analysis.slowStreak >= 2)
        embed.addFields({ name: '🐢 Slow Streak',  value: `${analysis.slowStreak} consecutive slow blocks`, inline: false });
    }

    await channel.send({ embeds: [embed] });
    console.log(`[Alert] Follow-up sent for block #${block.height}`);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

// !block / !smash
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
  const targetId = cfg.isPBS ? cfg.channels.stats : cfg.channels.block;
  if (targetId && targetId !== message.channelId) {
    await sendToChannel(targetId, embed);
  }
}

// !price
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
  const targetId = cfg.channels.price;
  if (targetId && targetId !== message.channelId) {
    await sendToChannel(targetId, embed);
  }
}

// !spell
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
      { name: '⏱ Elapsed', value: `${timeAgo(stats.elapsed)}`,            inline: true },
      { name: '📊 Avg',     value: `${Math.round(stats.avg)}s`,            inline: true },
      { name: '⚡ Status',  value: `${stats.statusEmoji} ${stats.status}`, inline: true },
    )
    .setFooter({ text: cfg.name })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  if (!cfg.isPBS && cfg.channels.spells && cfg.channels.spells !== message.channelId) {
    await sendToChannel(cfg.channels.spells, embed);
  }
}

// !boost
const boostSession = { active: false, participants: [], startTime: null, level: 'x4' };

async function cmdBoost(message, args, cfg) {
  const level = args[0] || 'x4';
  boostSession.active       = true;
  boostSession.participants = [message.author.username];
  boostSession.startTime    = Date.now();
  boostSession.level        = level;

  const embed = new EmbedBuilder()
    .setColor(0xFF00FF)
    .setTitle(`⚡ BOOST SESSION STARTED — ${level.toUpperCase()}`)
    .setDescription(`**${message.author.username}** has started a boost session!\n\nType \`!ready\` to join, then \`!go\` to execute.`)
    .addFields(
      { name: '🚀 Boost Level', value: `**${level}**`,                                       inline: true },
      { name: '👥 Participants', value: '1 so far',                                           inline: true },
      { name: '⏱ Started',      value: `<t:${Math.floor(Date.now() / 1000)}:R>`,             inline: true },
    )
    .setFooter({ text: cfg.name + ' • Saturdays 9PM UTC' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  const targetId = cfg.channels.boost;
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
  boostSession.active       = false;
  boostSession.participants = [];
}

// !roi
async function cmdROI(message, args) {
  const invest     = parseFloat(args[0]);
  const efficiency = parseFloat(args[1]);
  if (!invest || !efficiency) {
    return message.reply('Usage: `!roi <investment_usd> <w_per_th>` — e.g. `!roi 100 8`');
  }
  const prices      = await fetchPrices();
  const thPerDollar = 1 / 0.05;
  const estimatedTH = invest * thPerDollar;
  const dailyBTC    = estimatedTH * 0.0000001;
  const dailyUSD    = prices.btc ? dailyBTC * prices.btc : null;
  const monthlyUSD  = dailyUSD ? dailyUSD * 30 : null;
  const yearsROI    = monthlyUSD ? (invest / (monthlyUSD * 12)).toFixed(1) : '?';

  const embed = new EmbedBuilder()
    .setColor(0xF7931A)
    .setTitle('📊 ROI Calculator')
    .addFields(
      { name: '💵 Investment',    value: `$${invest}`,                          inline: true },
      { name: '⚡ Efficiency',    value: `${efficiency} W/TH`,                  inline: true },
      { name: '⛏ Est. Hashrate', value: `${estimatedTH.toFixed(0)} TH/s`,      inline: true },
      { name: '₿ Daily Est.',    value: dailyUSD  ? `$${dailyUSD.toFixed(2)} / day`  : 'N/A', inline: true },
      { name: '📅 Monthly Est.', value: monthlyUSD ? `$${monthlyUSD.toFixed(2)} / mo` : 'N/A', inline: true },
      { name: '📈 Est. ROI',     value: `~${yearsROI} years`,                   inline: true },
    )
    .setFooter({ text: 'Estimates only — actual results vary' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// !coord — UPGRADED with Prediction Engine v2
async function cmdCoord(message, cfg) {
  try {
    const blocks = await getRecentBlocks(BLOCK_SAMPLE_SIZE);
    const b      = blocks[0];
    if (!b) return message.reply('❌ Could not fetch block data — try again shortly.').catch(() => {});

    const minsElapsed = (Date.now() / 1000 - b.timestamp) / 60;
    const minsF       = minsElapsed.toFixed(1);
    const analysis    = deepBlockAnalysis(blocks);
    const wsStatus    = blockStore.wsConnected ? '🟢 Live (WebSocket)' : '🟡 Polling (REST)';

    let boostAdvice, color;
    if (minsElapsed < 2)       { boostAdvice = '🔥 **GO NOW!** Red Turbos + Rockets — prime window';       color = 0x10B981; }
    else if (minsElapsed < 5)  { boostAdvice = '🟢 **GOOD WINDOW** — Purple/Red boosts recommended';       color = 0x22C55E; }
    else if (minsElapsed < 8)  { boostAdvice = '🟡 **CAUTION** — Shield gains, light boosts only';         color = 0xF59E0B; }
    else if (minsElapsed < 12) { boostAdvice = '🟠 **DEFENSE ONLY** — Save spells for next round';         color = 0xF97316; }
    else                       { boostAdvice = '🔴 **BLOCK IMMINENT** — Wait for new block!';              color = 0xEF4444; }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`🎯 Boost Timing Advisor — Block #${b.height.toLocaleString()}`)
      .setDescription(boostAdvice)
      .setTimestamp();

    embed.addFields(
      { name: '⏱️ Block Age',        value: `${minsF} min`,                              inline: true },
      { name: '📡 Feed',              value: wsStatus,                                     inline: true },
      { name: '🔢 Sample',            value: `${analysis?.sampleSize ?? '?'} blocks`,      inline: true },

      { name: '🎯 P(Short <7min)',    value: `**${analysis?.pShort ?? '?'}%**`,            inline: true },
      { name: '🎯 P(Normal 7-14min)', value: `**${analysis?.pNormal ?? '?'}%**`,           inline: true },
      { name: '🎯 P(Long >14min)',    value: `**${analysis?.pLong ?? '?'}%**`,             inline: true },

      { name: '📈 Trend',
        value: `${analysis?.trend ?? '?'} · 10-blk: ${analysis?.avg10 ?? '?'}min · 50-blk: ${analysis?.avg50 ?? '?'}min`,
        inline: false },

      { name: '⏳ P(blk in 5min)',    value: `${analysis?.pNext5  ?? '?'}%`,              inline: true },
      { name: '⏳ P(blk in 10min)',   value: `${analysis?.pNext10 ?? '?'}%`,              inline: true },
      { name: '⏳ P(blk in 15min)',   value: `${analysis?.pNext15 ?? '?'}%`,              inline: true },
    );

    if (analysis?.fastStreak >= 2)
      embed.addFields({ name: '⚡ Fast Streak!', value: `${analysis.fastStreak} consecutive fast blocks!`, inline: false });
    if (analysis?.slowStreak >= 2)
      embed.addFields({ name: '🐢 Slow Streak',  value: `${analysis.slowStreak} consecutive slow blocks`, inline: false });
    if (mempoolStore.firstBlockFeeRate)
      embed.addFields({ name: '💸 Mempool', value: `Next block: ${mempoolStore.firstBlockFeeRate.toFixed(0)} sat/vB`, inline: true });
    if (analysis?.hashrateEH)
      embed.addFields({ name: '💪 Hashrate', value: `~${analysis.hashrateEH} EH/s`, inline: true });

    embed.setFooter({ text: `${cfg.name} • λ=${analysis?.lambda ?? '?'}min/block` });

    await message.reply({ embeds: [embed] });

  } catch (e) {
    console.error('[coord] Error:', e);
    message.reply('❌ Prediction error — try again shortly.').catch(() => {});
  }
}

// !epoch — difficulty epoch tracker
async function cmdEpoch(message, cfg) {
  try {
    const blocks   = await getRecentBlocks(BLOCK_SAMPLE_SIZE);
    const analysis = deepBlockAnalysis(blocks);
    if (!analysis) return message.reply('❌ No block data yet — try again shortly.').catch(() => {});

    const embed = new EmbedBuilder()
      .setColor(0x6366F1)
      .setTitle('⚙️ Difficulty Epoch Status')
      .addFields(
        { name: 'Current Height',       value: analysis.blockHeight.toLocaleString(),             inline: true },
        { name: 'Epoch Progress',        value: `${analysis.epochPosition} / 2016 blocks (${analysis.epochPct}%)`, inline: true },
        { name: 'Blocks Until Adjust',   value: analysis.epochRemaining.toLocaleString(),          inline: true },
        { name: 'Est. Adjustment',
          value: `${analysis.difficultyTrend}\n(~${analysis.difficultyChangePct}% change)`,
          inline: false },
        { name: 'Est. Hashrate',         value: analysis.hashrateEH ? `${analysis.hashrateEH} EH/s` : 'N/A', inline: true },
        { name: 'Avg Block Time (50blk)', value: `${analysis.avg50} min`, inline: true },
      )
      .setFooter({ text: cfg.name })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (e) {
    console.error('[epoch] Error:', e);
    message.reply('❌ Error — try again.').catch(() => {});
  }
}

// !verify — PBS only
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
      { name: '📅 Requested',     value: `<t:${Math.floor(Date.now() / 1000)}:F>` },
    )
    .setFooter({ text: 'Psychedelic Block Smashers — An officer will verify shortly' });

  await message.reply('✅ Verification request sent to officers!');
  if (cfg.channels.verify && cfg.channels.verify !== message.channelId) {
    await sendToChannel(cfg.channels.verify, embed, `👋 New member request from ${message.author}!`);
  }
  if (cfg.channels.announce) {
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x00FF88)
      .setTitle('🌱 New Member Request!')
      .setDescription(`${message.author} has applied to join PBS! Officers check #join-apply.`)
      .setTimestamp();
    await sendToChannel(cfg.channels.announce, welcomeEmbed);
  }
}

// !stats
async function cmdStats(message, cfg) {
  const guild = message.guild;
  const embed = new EmbedBuilder()
    .setColor(cfg.isPBS ? 0xFF00FF : 0x00FF88)
    .setTitle(`📊 ${cfg.name} Stats`)
    .setDescription('Here\'s a quick snapshot of the clan:')
    .addFields(
      { name: '👥 Members',    value: `${guild.memberCount}`,                          inline: true },
      { name: '🟢 Online',     value: `${guild.approximatePresenceCount || '?'}`,      inline: true },
      { name: '⛏ Min TH/s',   value: cfg.isPBS ? '20 TH/s' : 'Varies',               inline: true },
      { name: '📋 Ref Code',   value: '`A6JOY04`',                                    inline: true },
      { name: '⏰ Boost Time', value: 'Saturdays 9PM UTC',                            inline: true },
    )
    .setFooter({ text: 'Use !roi to calculate earnings' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// !channels
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

// !help
async function cmdHelp(message, cfg) {
  const baseCommands = `
\`!block\`  / \`!smash\`  — Block timing & status
\`!price\`             — BTC + GMT prices
\`!spell\`             — Spell cast recommendation
\`!coord\`             — 🆕 Boost timing advisor (v2 deep analysis)
\`!epoch\`             — 🆕 Difficulty epoch & hashrate tracker
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
    .setFooter({ text: `v6.1 • Prediction Engine v2 • ${cfg.name}` });
  await message.reply({ embeds: [embed] });
}

// ── Message handler ───────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const cfg     = getServerConfig(message.guild?.id);
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
      case 'epoch':    await cmdEpoch(message, cfg);           break;
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
    try { await message.reply(`⚠️ Error running \`!${command}\`: ${e.message}`); } catch {}
  }
});

// ── Hourly price update ───────────────────────────────────────────────────────
setInterval(async () => {
  const prices = await fetchPrices();
  if (!prices.btc) return;

  const embed = new EmbedBuilder()
    .setColor(0xF7931A)
    .setTitle('💰 Hourly Price Update')
    .addFields(
      { name: '₿ BTC', value: `$${prices.btc?.toLocaleString() || 'N/A'}`, inline: true },
      { name: '⛏ GMT', value: `$${prices.gmt?.toFixed(4) || 'N/A'}`,      inline: true },
    )
    .setTimestamp();

  const channels = [GRAV.price, PBS.price].filter(Boolean);
  for (const chId of channels) {
    await sendToChannel(chId, embed);
  }
}, 3600000);

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log('============================================');
  console.log(`  Miner Wars Bot v6.1 — PREDICTION ENGINE v2`);
  console.log(`  Logged in as: ${client.user.tag}`);
  console.log('============================================');

  const servers = client.guilds.cache.map(g => g.name).join(', ');
  console.log(`  Active in: ${servers || 'No servers yet'}`);
  console.log('--------------------------------------------');
  console.log('  GravitationaL channels:');
  console.log(`    Commands: ${GRAV.commands || 'NOT SET'}`);
  console.log(`    Block:    ${GRAV.block    || 'NOT SET'}`);
  console.log(`    Price:    ${GRAV.price    || 'NOT SET'}`);
  console.log(`    Boost:    ${GRAV.boost    || 'NOT SET'}`);
  console.log('--------------------------------------------');
  console.log('  PBS channels:');
  console.log(`    Commands: ${PBS.commands || 'NOT SET'}`);
  console.log(`    Boost:    ${PBS.boost    || 'NOT SET'}`);
  console.log(`    Stats:    ${PBS.stats    || 'NOT SET'}`);
  console.log(`    Price:    ${PBS.price    || 'NOT SET'}`);
  console.log(`    Verify:   ${PBS.verify   || 'NOT SET'}`);
  console.log('============================================');
  console.log(`  Alert channel: ${ALERT_CHANNEL_ID}`);
  console.log('============================================');

  client.user.setActivity('⛏ Smashing Blocks', { type: 0 });

  // Prime block cache on startup
  getRecentBlocks(BLOCK_SAMPLE_SIZE).catch(console.error);

  // Start live WebSocket connection to mempool.space
  initBlockWebSocket();

  console.log('[Boot] Prediction Engine v2 ready — sample=50 blocks, λ-window=20');
});

client.on('error', e => console.error('[Client Error]', e.message));
process.on('unhandledRejection', e => console.error('[Unhandled]', e?.message));

if (!TOKEN) {
  console.error('❌  BOT_TOKEN / DISCORD_TOKEN not set!');
  process.exit(1);
}

client.login(TOKEN);
