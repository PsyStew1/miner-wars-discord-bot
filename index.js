// MINER WARS BOT v4 - Full Featured
// Features: block tracking, price, spell, boost coordination, ROI, !coord timing advisor
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const CONFIG = { 
    BOT_TOKEN: process.env.BOT_TOKEN, 
    ALERT_CHANNEL_ID: process.env.CHANNEL_ID 
};

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

let lastBlockHeight = 0;
let lastBlockTime = 0;
let boostSession = null;
let readyMembers = new Set();
let priceCache = { data: null, timestamp: 0 };
let blockHistory = [];

// ============== API FUNCTIONS ==============

async function getBlock() {
    try { 
        const r = await fetch('https://mempool.space/api/v1/blocks'); 
        if (!r.ok) return null;
        const data = await r.json();
        return data && data[0] ? data[0] : null;
    } catch(e) { 
        console.log('Block error:', e.message);
        return null; 
    }
}

async function getPrice() {
    // Cache prices for 60 seconds to avoid rate limits
    const now = Date.now();
    if (priceCache.data && (now - priceCache.timestamp) < 60000) {
        return priceCache.data;
    }
    try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gomining-token,bitcoin&vs_currencies=usd&include_24hr_change=true');
        if (!r.ok) return priceCache.data || null;
        const d = await r.json();
        priceCache = { data: d, timestamp: now };
        return d;
    } catch(e) { 
        console.log('Price error:', e.message);
        return priceCache.data || null; 
    }
}

async function getRecentBlocks() {
    try {
        const r = await fetch('https://mempool.space/api/v1/blocks');
        if (!r.ok) return [];
        return await r.json();
    } catch(e) {
        return [];
    }
}

// ============== HELPER FUNCTIONS ==============

function getSpellRecommendation(mins) {
    if (mins < 2) return { spell: '🚀 ROCKET + PPS', phase: 'BLOCK START', color: 0x10B981, advice: 'GO HARD! Best time for instant boosts' };
    if (mins < 5) return { spell: '🟣 Purple/Red Boosts', phase: 'EARLY ROUND', color: 0x10B981, advice: 'Good window for boosting' };
    if (mins < 8) return { spell: '🛡️ Shield Up', phase: 'MID ROUND', color: 0xF59E0B, advice: 'Boost cautiously, defend gains' };
    if (mins < 12) return { spell: '⏳ Wait/Defend', phase: 'LATE ROUND', color: 0xF97316, advice: 'Save for next round' };
    return { spell: '🔴 HOLD - Block Soon!', phase: 'BLOCK ENDING', color: 0xEF4444, advice: 'New block imminent!' };
}

function calculateProbabilities(recentBlocks) {
    if (!recentBlocks || recentBlocks.length < 2) {
        return { short: 33, normal: 34, long: 33, avgTime: 10 };
    }
    
    const times = [];
    for (let i = 0; i < recentBlocks.length - 1 && i < 20; i++) {
        const diff = (recentBlocks[i].timestamp - recentBlocks[i+1].timestamp) / 60;
        times.push(diff);
    }
    
    const avgTime = times.reduce((a,b) => a+b, 0) / times.length;
    const shortCount = times.filter(t => t < 5).length;
    const normalCount = times.filter(t => t >= 5 && t < 12).length;
    const longCount = times.filter(t => t >= 12).length;
    const total = times.length;
    
    return {
        short: Math.round((shortCount / total) * 100),
        normal: Math.round((normalCount / total) * 100),
        long: Math.round((longCount / total) * 100),
        avgTime: avgTime.toFixed(1)
    };
}

// ============== MESSAGE HANDLER ==============

client.on('messageCreate', async msg => {
    if (msg.author.bot || !msg.content.startsWith('!')) return;
    const parts = msg.content.slice(1).toLowerCase().split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    // !block - Current block status
    if (cmd === 'block') {
        try {
            const b = await getBlock();
            if (!b) return msg.reply('❌ Could not fetch block data').catch(()=>{});
            const mins = ((Date.now() - b.timestamp * 1000) / 60000).toFixed(1);
            const rec = getSpellRecommendation(parseFloat(mins));
            
            const embed = new EmbedBuilder()
                .setColor(rec.color)
                .setTitle('⛏️ Block Status')
                .addFields(
                    { name: 'Block', value: `#${b.height.toLocaleString()}`, inline: true },
                    { name: 'Round Time', value: `${mins} min`, inline: true },
                    { name: 'Phase', value: rec.phase, inline: true },
                    { name: 'Recommended', value: rec.spell, inline: false }
                )
                .setFooter({ text: 'mempool.space' })
                .setTimestamp();
            msg.reply({ embeds: [embed] }).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error fetching block').catch(()=>{});
        }
    }

    // !price - GMT and BTC prices
    if (cmd === 'price') {
        try {
            const p = await getPrice();
            if (!p) return msg.reply('❌ Price unavailable (rate limited - try again in 1 min)').catch(()=>{});
            
            const gmt = p['gomining-token'];
            const btc = p['bitcoin'];
            
            const embed = new EmbedBuilder()
                .setColor(0xF59E0B)
                .setTitle('💰 Prices')
                .addFields(
                    { name: 'GOMINING', value: gmt ? `$${gmt.usd.toFixed(4)} (${gmt.usd_24h_change?.toFixed(1) || '?'}%)` : 'N/A', inline: true },
                    { name: 'Bitcoin', value: btc ? `$${btc.usd.toLocaleString()} (${btc.usd_24h_change?.toFixed(1) || '?'}%)` : 'N/A', inline: true }
                )
                .setFooter({ text: 'CoinGecko • Cached 60s' })
                .setTimestamp();
            msg.reply({ embeds: [embed] }).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error fetching prices').catch(()=>{});
        }
    }

    // !spell - Spell recommendation based on current timing
    if (cmd === 'spell') {
        try {
            const b = await getBlock();
            if (!b) return msg.reply('❌ Could not fetch block data').catch(()=>{});
            const mins = parseFloat(((Date.now() - b.timestamp * 1000) / 60000).toFixed(1));
            const rec = getSpellRecommendation(mins);
            
            const embed = new EmbedBuilder()
                .setColor(rec.color)
                .setTitle('🔮 Spell Recommendation')
                .setDescription(`**${rec.spell}**`)
                .addFields(
                    { name: 'Phase', value: rec.phase, inline: true },
                    { name: 'Round Time', value: `${mins} min`, inline: true },
                    { name: 'Advice', value: rec.advice, inline: false }
                )
                .setTimestamp();
            msg.reply({ embeds: [embed] }).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error').catch(()=>{});
        }
    }

    // !coord - Boost coordination timing advisor (NEW in v4!)
    if (cmd === 'coord') {
        try {
            const b = await getBlock();
            const blocks = await getRecentBlocks();
            if (!b) return msg.reply('❌ Could not fetch block data').catch(()=>{});
            
            const mins = parseFloat(((Date.now() - b.timestamp * 1000) / 60000).toFixed(1));
            const rec = getSpellRecommendation(mins);
            const probs = calculateProbabilities(blocks);
            
            let boostAdvice = '';
            let alertMsg = '';
            
            if (mins < 2) {
                boostAdvice = '🔥 **GO NOW!** Red Turbos + Rockets\n• Instant boosts most effective\n• Full clan coordination optimal';
            } else if (mins < 5) {
                boostAdvice = '🟢 **GOOD WINDOW**\n• Purple/Red boosts recommended\n• Echo boost if committing\n• Coordinate with clan';
            } else if (mins < 8) {
                boostAdvice = '🟡 **CAUTIOUS ZONE**\n• Shield up existing gains\n• Light boosts only\n• Save big spells for next';
            } else if (mins < 12) {
                boostAdvice = '🟠 **DEFENSE ONLY**\n• No new boosts!\n• Protect current position\n• Prepare for next round';
            } else {
                boostAdvice = '🔴 **BLOCK IMMINENT**\n• WAIT for new block!\n• Round likely ending soon\n• Ready your spells';
            }
            
            // Alert conditions
            if (probs.long > 40) alertMsg += '\n⚡ **HIGH LONG ROUND PROBABILITY** - Echo boost viable!';
            if (mins > 15) alertMsg += '\n🎰 **OVERDUE** - Block any moment now!';
            if (probs.short > 40 && mins < 3) alertMsg += '\n⚡ **FAST BLOCKS TRENDING** - Act quick!';
            
            const embed = new EmbedBuilder()
                .setColor(rec.color)
                .setTitle('🎯 Boost Coordinator')
                .setDescription(boostAdvice)
                .addFields(
                    { name: '⏱️ Round Time', value: `${mins} min`, inline: true },
                    { name: '📊 Phase', value: rec.phase, inline: true },
                    { name: '📈 Avg Block', value: `${probs.avgTime} min`, inline: true },
                    { name: '🎲 Probabilities', value: `Short: ${probs.short}% | Normal: ${probs.normal}% | Long: ${probs.long}%`, inline: false }
                )
                .setFooter({ text: 'Based on last 20 blocks • Not financial advice' })
                .setTimestamp();
            
            if (alertMsg) {
                embed.addFields({ name: '🚨 Alerts', value: alertMsg, inline: false });
            }
            
            msg.reply({ embeds: [embed] }).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error').catch(()=>{});
        }
    }

    // !boost [multiplier] - Start a boost coordination session
    if (cmd === 'boost') {
        const mult = args[0] || 'x8';
        boostSession = { mult, starter: msg.author.id, time: Date.now() };
        readyMembers.clear();
        readyMembers.add(msg.author.id);
        
        const embed = new EmbedBuilder()
            .setColor(0x8B5CF6)
            .setTitle('🚀 BOOST SESSION STARTED!')
            .setDescription(`**${mult}** multiplier round!\nType \`!ready\` to join`)
            .addFields(
                { name: 'Started by', value: `<@${msg.author.id}>`, inline: true },
                { name: 'Ready', value: '1 member', inline: true }
            )
            .setTimestamp();
        msg.channel.send({ embeds: [embed] }).catch(()=>{});
    }

    // !ready - Join boost session
    if (cmd === 'ready') {
        if (!boostSession) return msg.reply('No active session. Start with `!boost x8`').catch(()=>{});
        readyMembers.add(msg.author.id);
        msg.reply(`✅ Ready! **${readyMembers.size}** member(s) waiting`).catch(()=>{});
    }

    // !go - Execute the coordinated boost
    if (cmd === 'go') {
        if (!boostSession) return msg.reply('No active session').catch(()=>{});
        
        const embed = new EmbedBuilder()
            .setColor(0xEF4444)
            .setTitle('🔥🔥🔥 BOOST NOW! 🔥🔥🔥')
            .setDescription(`**${readyMembers.size}** members - EXECUTE YOUR BOOSTS!`)
            .addFields({ name: 'Multiplier', value: boostSession.mult, inline: true })
            .setTimestamp();
        
        msg.channel.send({ content: '@here', embeds: [embed] }).catch(()=>{});
        boostSession = null;
        readyMembers.clear();
    }

    // !roi [cost] [multiplier] - ROI calculator
    if (cmd === 'roi') {
        const cost = parseInt(args[0]) || 100;
        const mult = parseInt(args[1]) || 8;
        const baseReward = 296;
        const potential = baseReward * mult;
        const profit = potential - cost;
        const breakeven = ((cost / potential) * 100).toFixed(1);
        
        let verdict = '';
        if (profit > cost * 2) verdict = '🟢 **GOOD** - Strong potential';
        else if (profit > cost) verdict = '🟡 **MARGINAL** - Proceed with caution';
        else verdict = '🔴 **RISKY** - Consider skipping';
        
        const embed = new EmbedBuilder()
            .setColor(profit > cost ? 0x10B981 : 0xEF4444)
            .setTitle('📊 ROI Calculator')
            .addFields(
                { name: 'Cost', value: `${cost} GMT`, inline: true },
                { name: 'Multiplier', value: `x${mult}`, inline: true },
                { name: 'Potential', value: `${potential} GMT`, inline: true },
                { name: 'Profit', value: `${profit} GMT`, inline: true },
                { name: 'Break-even', value: `${breakeven}% win rate`, inline: true },
                { name: 'Verdict', value: verdict, inline: false }
            )
            .setFooter({ text: 'Assumes base reward of 296 GMT' })
            .setTimestamp();
        msg.reply({ embeds: [embed] }).catch(()=>{});
    }

    // !help - Show all commands
    if (cmd === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x3B82F6)
            .setTitle('⛏️ Miner Wars Bot v4')
            .setDescription('Commands for Miner Wars strategy')
            .addFields(
                { name: '📊 Info Commands', value: '`!block` - Block status\n`!price` - GMT/BTC prices\n`!spell` - Spell recommendation', inline: false },
                { name: '🎯 Strategy', value: '`!coord` - Boost timing advisor\n`!roi [cost] [mult]` - ROI calculator', inline: false },
                { name: '🚀 Coordination', value: '`!boost [x8]` - Start session\n`!ready` - Join session\n`!go` - Execute boost', inline: false }
            )
            .setFooter({ text: 'Made for GoMining Miner Wars' })
            .setTimestamp();
        msg.reply({ embeds: [embed] }).catch(()=>{});
    }
});

// ============== AUTO ALERTS ==============

client.once('ready', () => {
    console.log(`⛏️ Miner Wars Bot v4 online as ${client.user.tag}`);
    
    // Check for new blocks every 30 seconds
    setInterval(async () => {
        try {
            const b = await getBlock();
            if (!b) return;
            
            if (b.height > lastBlockHeight && lastBlockHeight > 0) {
                const ch = client.channels.cache.get(CONFIG.ALERT_CHANNEL_ID);
                if (ch) {
                    const embed = new EmbedBuilder()
                        .setColor(0x10B981)
                        .setTitle('⛏️ NEW BLOCK MINED!')
                        .setDescription(`Block **#${b.height.toLocaleString()}** - New round starting!`)
                        .addFields({ name: 'Best Action', value: '🚀 Rocket + PPS NOW!', inline: false })
                        .setTimestamp();
                    ch.send({ content: '@here', embeds: [embed] }).catch(()=>{});
                }
            }
            lastBlockHeight = b.height;
            lastBlockTime = b.timestamp;
        } catch(e) {
            console.log('Block check error:', e.message);
        }
    }, 30000);
});

client.on('error', (e) => console.log('Client error:', e.message));

client.login(CONFIG.BOT_TOKEN);
