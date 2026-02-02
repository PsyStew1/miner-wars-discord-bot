// MINER WARS BOT v2 - Fixed
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const CONFIG = { BOT_TOKEN: process.env.BOT_TOKEN, ALERT_CHANNEL_ID: process.env.CHANNEL_ID };
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let lastBlockHeight = 0, boostSession = null, readyMembers = new Set(), priceCache = { data: null, ts: 0 };

async function getBlock() {
    try { const r = await fetch('https://mempool.space/api/v1/blocks'); return r.ok ? (await r.json())[0] : null; } catch { return null; }
}
async function getPrice() {
    try {
        if (priceCache.data && Date.now() - priceCache.ts < 60000) return priceCache.data;
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gomining-token,bitcoin&vs_currencies=usd&include_24hr_change=true');
        if (!r.ok) return priceCache.data;
        const d = await r.json();
        if (d['gomining-token'] && d.bitcoin) { priceCache = { data: d, ts: Date.now() }; return d; }
        return priceCache.data;
    } catch { return priceCache.data; }
}

client.on('messageCreate', async msg => {
    if (msg.author.bot || !msg.content.startsWith('!')) return;
    const [cmd, ...args] = msg.content.slice(1).toLowerCase().split(' ');
    
    if (cmd === 'block') {
        const b = await getBlock();
        if (!b) return msg.reply('❌ Error fetching block');
        const mins = ((Date.now() - b.timestamp * 1000) / 60000).toFixed(1);
        const status = mins < 5 ? '🟢 Early' : mins < 10 ? '🟡 Mid' : '🔴 Long';
        msg.reply({ embeds: [new EmbedBuilder().setColor(0xFBBF24).setTitle('⏱️ Block Status').addFields(
            { name: 'Height', value: b.height.toLocaleString(), inline: true },
            { name: 'Time', value: `${mins} min`, inline: true },
            { name: 'Status', value: status, inline: true }
        ).setTimestamp()] });
    }
    if (cmd === 'price') {
        const p = await getPrice();
        if (!p) return msg.reply('❌ Price API rate limited. Try in 1 min.');
        const gmt = p['gomining-token'], btc = p.bitcoin, ch = gmt.usd_24h_change || 0;
        msg.reply({ embeds: [new EmbedBuilder().setColor(ch >= 0 ? 0x10B981 : 0xEF4444).setTitle('💰 Prices').addFields(
            { name: 'GMT', value: `$${gmt.usd.toFixed(4)} (${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%)`, inline: true },
            { name: 'BTC', value: `$${btc.usd.toLocaleString()}`, inline: true }
        ).setTimestamp()] });
    }
    if (cmd === 'spell') {
        const b = await getBlock();
        if (!b) return msg.reply('❌ Error');
        const mins = (Date.now() - b.timestamp * 1000) / 60000;
        const rec = mins < 3 ? '🚀 ROCKET' : mins < 6 ? '🌀 ECHO' : mins < 10 ? '⚡ INSTANT' : '🎯 FOCUS';
        msg.reply(`**Spell** (${mins.toFixed(1)} min): ${rec}`);
    }
    if (cmd === 'boost') { boostSession = args[0] || 'x8'; readyMembers.clear(); readyMembers.add(msg.author.id); msg.channel.send(`@here 🚀 **BOOST ${boostSession}** - Type !ready`); }
    if (cmd === 'ready') { if (!boostSession) return msg.reply('No session'); readyMembers.add(msg.author.id); msg.reply(`✅ ${readyMembers.size} ready`); }
    if (cmd === 'go') { if (!boostSession) return msg.reply('No session'); msg.channel.send(`@here 🔥 **GO!** ${readyMembers.size} members`); boostSession = null; }
    if (cmd === 'roi') { const t = parseInt(args[0]) || 100, m = parseInt(args[1]) || 8; msg.reply(`📊 Cost: ${t} | x${m} | Potential: ${296*m} GMT`); }
    if (cmd === 'help') { msg.reply('**Commands:** !block !price !spell !boost !ready !go !roi'); }
});

client.once('ready', () => { console.log(`⛏️ Bot online as ${client.user.tag}`); setInterval(async () => {
    const b = await getBlock(); if (!b) return;
    const ch = client.channels.cache.get(CONFIG.ALERT_CHANNEL_ID);
    if (b.height > lastBlockHeight && lastBlockHeight > 0 && ch) ch.send('@here ⛏️ NEW BLOCK!');
    lastBlockHeight = b.height;
}, 30000); });

client.login(CONFIG.BOT_TOKEN);
