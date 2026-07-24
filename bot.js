// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const mongoose = require('mongoose');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ====================== MONGO ======================
let GuildConfig = null;

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.log('⚠️ Keine MongoDB URI – Bot läuft ohne Persistenz');
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'apex' });
  const guildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} }
  }, { timestamps: true });
  GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', guildConfigSchema);
  console.log('✅ MongoDB verbunden');
}

async function getConfig(guildId) {
  if (!GuildConfig) return {};
  const doc = await GuildConfig.findOne({ guildId }).lean();
  return doc?.data || {};
}

// ====================== TEAMLISTE ======================
async function updateTeamliste(guild) {
  const config = await getConfig(guild.id);
  const cfg = config.teamliste || {};
  if (!cfg.channelId || !cfg.roles?.length) return;

  const channel = guild.channels.cache.get(cfg.channelId);
  if (!channel) return;

  let desc = '**🌟 Teamliste**\n\n';
  for (const roleId of cfg.roles) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const members = role.members.map(m => 
      `• ${m.user} ${m.presence?.status === 'online' ? '🟢' : '⚫'}`
    ).join('\n') || '_Keine Mitglieder_';

    desc += `**${role.name}** (${role.members.size})\n${members}\n\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('Team Übersicht')
    .setDescription(desc)
    .setColor('#ffffff')
    .setTimestamp();

  const messages = await channel.messages.fetch({ limit: 5 });
  const existing = messages.find(m => m.author.id === client.user.id);

  if (existing) await existing.edit({ embeds: [embed] });
  else await channel.send({ embeds: [embed] });
}

// ====================== WELCOME ======================
client.on('guildMemberAdd', async member => {
  const config = await getConfig(member.guild.id);
  const w = config.welcome?.join || {};
  if (!w.enabled || !w.channelId) return;

  const channel = member.guild.channels.cache.get(w.channelId);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(w.title || `Willkommen auf ${member.guild.name}!`)
    .setDescription((w.text || 'Willkommen {user}!').replace('{user}', member.toString()))
    .setColor(w.color || '#ffffff')
    .setThumbnail(w.useAvatarThumbnail ? member.user.displayAvatarURL({ dynamic: true }) : null);

  if (w.image) embed.setImage(w.image);

  channel.send({ embeds: [embed] });

  // Auto-Rollen
  if (w.roles?.length) {
    for (const roleId of w.roles) {
      const role = member.guild.roles.cache.get(roleId);
      if (role) member.roles.add(role).catch(() => {});
    }
  }
});

// Leave (optional)
client.on('guildMemberRemove', async member => {
  const config = await getConfig(member.guild.id);
  const l = config.welcome?.leave || {};
  if (!l.enabled || !l.channelId) return;

  const channel = member.guild.channels.cache.get(l.channelId);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(l.title || 'Auf Wiedersehen 👋')
    .setDescription((l.text || '{user} hat den Server verlassen.').replace('{user}', member.user.tag))
    .setColor(l.color || '#ffffff')
    .setThumbnail(l.useAvatarThumbnail ? member.user.displayAvatarURL() : null);

  if (l.image) embed.setImage(l.image);
  channel.send({ embeds: [embed] });
});

// ====================== TICKETS (Basis) ======================
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'ticket_panel') return;

  const config = await getConfig(interaction.guild.id);
  const ticketCfg = config.tickets || {};

  await interaction.reply({
    content: '✅ Ticket wird erstellt...',
    ephemeral: true
  });

  // Hier kannst du später vollständige Ticket-Erstellung (Kanal erstellen etc.) erweitern
});

// ====================== EVENTS ======================
client.on('guildMemberUpdate', async (oldM, newM) => {
  if (oldM.roles.cache.size !== newM.roles.cache.size) {
    updateTeamliste(newM.guild).catch(console.error);
  }
});

client.on('ready', () => {
  console.log(`🚀 Apex Bot online als ${client.user.tag}`);
  client.guilds.cache.forEach(g => updateTeamliste(g).catch(console.error));
});

(async () => {
  await connectDB();
  client.login(process.env.BOT_TOKEN);
})();
