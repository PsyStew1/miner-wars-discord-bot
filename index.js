// MINER WARS DISCORD BOT - Railway Version
// Uses environment variables for secrets

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

// CONFIG - Uses environment variables (set in Railway)
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    ALERT_CHANNEL_ID: process.env.CHANNEL_ID,
    BLOCK_ALERT_MINUTES: 12,
};

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let lastBlockHeight = 0, boostSession = null, readyMembers = new Set();

async function getBlock() {
    try {
        const res = await fetch('https://mempool.space/api/v1/blocks');
        return (await res.json())[0];
    } catch(e) { return null; }
}

async function getPrice() {
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gomining-token,bitcoin&vs_currencies=usd&include_24hr_change=true');
        return await res.json();
    } catch(e) { return null; }
}

async function checkBlocks() {
    const block = await getBlock();
    if (!block) return;
    const channel = client.channels.cache.get(CONFIG.ALERT_CHANNEL_ID);
    if (!channel) return;
    
    if (block.height > lastBlockHeight && lastBlockHeight > 0) {
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('⛏️ NEW BLOCK MINED!')
            .setDescription(`Block **${block.height}** - New round starting!`)
            .addFields({ name: 'Best Spell', value: '🚀 Rocket/PPS', inline: true });
        channel.send({ content: '@here', embeds: [embed] });
    }
    lastBlockHeight = block.height;
}

client.on('messageCreate', async msg => {
    if (msg.author.bot || !msg.content.startsWith('!')) return;
    const [cmd, ...args] = msg.content.slice(1).split(' ');

    if (cmd === 'block') {
        const block = await getBlock();
        if (!block) return msg.reply('❌ Error');
        const mins = ((Date.now() - block.timestamp * 1000) / 60000).toFixed(1);
        const status = mins < 5 ? '🟢 Early' : mins < 10 ? '🟡 Mid' : '🔴 Long';
        const embed = new EmbedBuilder()
            .setColor(0xFBBF24)
            .setTitle('⏱️ Block Status')
            .addFields(
                { name: 'Height', value: block.height.toLocaleString(), inline: true },
                { name: 'Time', value: `${mins} min`, inline: true },
                { name: 'Status', value: status, inline: true }
            );
        msg.reply({ embeds: [embed] });
    }

    if (cmd === 'price') {
        const p = await getPrice();
        if (!p) return msg.reply('❌ Error');
        const gmt = p['gomining-token'];
        const btc = p.bitcoin;
        const embed = new EmbedBuilder()
            .setColor(gmt.usd_24h_change >= 0 ? 0x10B981 : 0xEF4444)
            .setTitle('💰 Prices')
            .addFields(
                { name: 'GMT', value: `$${gmt.usd.toFixed(4)} (${gmt.usd_24h_change >= 0 ? '+' : ''}${gmt.usd_24h_change.toFixed(2)}%)`, inline: true },
                { name: 'BTC', value: `$${btc.usd.toLocaleString()}`, inline: true }
            );
        msg.reply({ embeds: [embed] });
    }

    if (cmd === 'spell') {
        const block = await getBlock();
        if (!block) return msg.reply('❌ Error');
        const mins = (Date.now() - block.timestamp * 1000) / 60000;
        let rec;
        if (mins < 3) rec = '🚀 **ROCKET** - Max duration!';
        else if (mins < 6) rec = '🌀 **ECHO** - Good for long rounds';
        else if (mins < 10) rec = '⚡ **INSTANT** - Safe choice';
        else rec = '🎯 **FOCUS** - Risky but could pay off!';
        msg.reply(`**Spell Recommendation** (${mins.toFixed(1)} min)\n${rec}`);
    }

    if (cmd === 'boost') {
        const mult = args[0] || 'x8';
        boostSession = { mult, by: msg.author.username };
        readyMembers.clear();
        readyMembers.add(msg.author.id);
        const embed = new EmbedBuilder()
            .setColor(0x8B5CF6)
            .setTitle(`🚀 BOOST: ${mult}`)
            .setDescription(`${msg.author.username} coordinating!\nType \`!ready\` to join.`)
            .addFields({ name: 'Ready', value: `${readyMembers.size}`, inline: true });
        msg.channel.send({ content: '@here', embeds: [embed] });
    }

    if (cmd === 'ready') {
        if (!boostSession) return msg.reply('No session. Start with !boost x8');
        readyMembers.add(msg.author.id);
        msg.reply(`✅ Ready! ${readyMembers.size} members waiting`);
    }

    if (cmd === 'go') {
        if (!boostSession) return msg.reply('No session');
        msg.channel.send(`@here 🔥 **BOOST NOW!** ${readyMembers.size} members GO! 🔥`);
        boostSession = null;
    }

    if (cmd === 'roi') {
        const tokens = parseInt(args[0]) || 100;
        const mult = parseInt(args[1]) || 8;
        const reward = 296 * mult;
        msg.reply(`📊 **ROI** | Cost: ${tokens} GMT | x${mult} | Potential: ${reward} GMT`);
    }

    if (cmd === 'help') {
        msg.reply('**Commands:**\n`!block` - Status\n`!price` - Prices\n`!spell` - Recommendation\n`!boost [x]` - Start session\n`!ready` - Join session\n`!go` - Execute\n`!roi [tokens] [mult]` - Calculate');
    }
});

client.once('ready', () => {
    console.log(`⛏️ Miner Wars Bot online as ${client.user.tag}`);
    setInterval(checkBlocks, 30000);
});

client.login(CONFIG.BOT_TOKEN);
