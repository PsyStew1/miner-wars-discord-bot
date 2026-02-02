// MINER WARS BOT v3 - Bulletproof
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const CONFIG = { 
    BOT_TOKEN: process.env.BOT_TOKEN, 
    ALERT_CHANNEL_ID: process.env.CHANNEL_ID 
};

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

let lastBlockHeight = 0, boostSession = null, readyMembers = new Set();

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
    try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gomining-token,bitcoin&vs_currencies=usd&include_24hr_change=true');
        if (!r.ok) return null;
        const d = await r.json();
        return d;
    } catch(e) { 
        console.log('Price error:', e.message);
        return null; 
    }
}

client.on('messageCreate', async msg => {
    if (msg.author.bot || !msg.content.startsWith('!')) return;
    const cmd = msg.content.slice(1).toLowerCase().split(' ')[0];
    const args = msg.content.slice(1).toLowerCase().split(' ').slice(1);

    if (cmd === 'block') {
        try {
            const b = await getBlock();
            if (!b) return msg.reply('❌ Could not fetch block data').catch(()=>{});
            const mins = ((Date.now() - b.timestamp * 1000) / 60000).toFixed(1);
            const status = mins < 5 ? '🟢 Early' : mins < 10 ? '🟡 Mid' : '🔴 Long';
            const embed = new EmbedBuilder()
                .setColor(0xFBBF24)
                .setTitle('⏱️ Block Status')
                .addFields(
                    { name: 'Height', value: String(b.height), inline: true },
                    { name: 'Time', value: `${mins} min`, inline: true },
                    { name: 'Status', value: status, inline: true }
                )
                .setTimestamp();
            msg.reply({ embeds: [embed] }).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error').catch(()=>{});
        }
    }

    if (cmd === 'price') {
        try {
            const p = await getPrice();
            if (!p) return msg.reply('❌ Price API unavailable. Try again in 1 min.').catch(()=>{});
            
            let gmtPrice = 'N/A', gmtChange = 'N/A', btcPrice = 'N/A';
            
            if (p['gomining-token'] && p['gomining-token'].usd !== undefined) {
                gmtPrice = '$' + p['gomining-token'].usd.toFixed(4);
                if (p['gomining-token'].usd_24h_change !== undefined) {
                    const ch = p['gomining-token'].usd_24h_change;
                    gmtChange = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
                }
            }
            
            if (p.bitcoin && p.bitcoin.usd !== undefined) {
                btcPrice = '$' + Math.round(p.bitcoin.usd).toLocaleString();
            }
            
            const embed = new EmbedBuilder()
                .setColor(0xFBBF24)
                .setTitle('💰 Prices')
                .addFields(
                    { name: 'GMT', value: `${gmtPrice} (${gmtChange})`, inline: true },
                    { name: 'BTC', value: btcPrice, inline: true }
                )
                .setTimestamp();
            msg.reply({ embeds: [embed] }).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error fetching prices').catch(()=>{});
        }
    }

    if (cmd === 'spell') {
        try {
            const b = await getBlock();
            if (!b) return msg.reply('❌ Could not fetch block').catch(()=>{});
            const mins = (Date.now() - b.timestamp * 1000) / 60000;
            let rec = '🎯 FOCUS';
            if (mins < 3) rec = '🚀 ROCKET';
            else if (mins < 6) rec = '🌀 ECHO';
            else if (mins < 10) rec = '⚡ INSTANT';
            msg.reply(`**Spell** (${mins.toFixed(1)} min): ${rec}`).catch(()=>{});
        } catch(e) {
            msg.reply('❌ Error').catch(()=>{});
        }
    }

    if (cmd === 'boost') {
        boostSession = args[0] || 'x8';
        readyMembers.clear();
        readyMembers.add(msg.author.id);
        msg.channel.send(`@here 🚀 **BOOST ${boostSession}** started by ${msg.author.username}! Type \`!ready\``).catch(()=>{});
    }

    if (cmd === 'ready') {
        if (!boostSession) return msg.reply('No active session. Start with !boost').catch(()=>{});
        readyMembers.add(msg.author.id);
        msg.reply(`✅ Ready! ${readyMembers.size} member(s) waiting`).catch(()=>{});
    }

    if (cmd === 'go') {
        if (!boostSession) return msg.reply('No active session').catch(()=>{});
        msg.channel.send(`@here 🔥 **BOOST NOW!** ${readyMembers.size} members - GO GO GO! 🔥`).catch(()=>{});
        boostSession = null;
        readyMembers.clear();
    }

    if (cmd === 'roi') {
        const tokens = parseInt(args[0]) || 100;
        const mult = parseInt(args[1]) || 8;
        const potential = 296 * mult;
        msg.reply(`📊 **ROI** | Cost: ${tokens} GMT | x${mult} | Potential: ${potential} GMT | Profit: ${potential - tokens} GMT`).catch(()=>{});
    }

    if (cmd === 'help') {
        msg.reply('**Commands:** `!block` `!price` `!spell` `!boost [x]` `!ready` `!go` `!roi [cost] [mult]`').catch(()=>{});
    }
});

client.once('ready', () => {
    console.log(`⛏️ Miner Wars Bot online as ${client.user.tag}`);
    
    setInterval(async () => {
        try {
            const b = await getBlock();
            if (!b) return;
            if (b.height > lastBlockHeight && lastBlockHeight > 0) {
                const ch = client.channels.cache.get(CONFIG.ALERT_CHANNEL_ID);
                if (ch) ch.send('@here ⛏️ **NEW BLOCK MINED!** New round starting!').catch(()=>{});
            }
            lastBlockHeight = b.height;
        } catch(e) {}
    }, 30000);
});

client.on('error', (e) => console.log('Client error:', e.message));
client.login(CONFIG.BOT_TOKEN);
