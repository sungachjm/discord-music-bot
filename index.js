require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');

if (!process.env.TOKEN?.trim()) {
  console.error('❌ Thiếu biến môi trường: TOKEN');
  process.exit(1);
}

const {
  TOKEN,
  GUILD_ID,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  LAVALINK_SECURE,
} = process.env;
const LAVALINK_URL = process.env.LAVALINK_URL || 'localhost:2333';
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || 'youshallnotpass';

const COLOR = 0x2b2d31; // nhìn như "trong suốt" ở dark mode
const MAX_QUEUE = 200;
const IDLE_MS = 2 * 60_000; // hết nhạc 2 phút thì rời kênh
const ALONE_MS = 60_000; // không còn ai trong kênh 1 phút thì rời
const LOOP_LABEL = { off: 'Tắt', track: 'Bài hiện tại', queue: 'Cả hàng chờ' };
const SPOTIFY_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------- Lavalink ----------
const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [
    {
      name: 'main',
      url: LAVALINK_URL,
      auth: LAVALINK_PASSWORD,
      secure: LAVALINK_SECURE === 'true',
    },
  ],
  { reconnectTries: 10, reconnectInterval: 5, moveOnDisconnect: false },
);
shoukaku.on('ready', (name, reconnected) =>
  console.log(`🎵 Lavalink "${name}" ${reconnected ? 'đã kết nối lại' : 'sẵn sàng'}`),
);
shoukaku.on('error', (name, err) => console.error(`❌ Lavalink "${name}":`, err?.message ?? err));
shoukaku.on('close', (name, code) => console.warn(`⚠️ Lavalink "${name}" đóng kết nối (mã ${code})`));

// ---------- Slash commands ----------
const cmd = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description);
const commands = [
  cmd('play', 'Phát nhạc từ YouTube, SoundCloud hoặc Spotify').addStringOption((o) =>
    o
      .setName('query')
      .setDescription('Tên bài hát hoặc link')
      .setRequired(true)
      .setAutocomplete(true),
  ),
  cmd('pause', 'Tạm dừng nhạc'),
  cmd('resume', 'Tiếp tục phát nhạc'),
  cmd('skip', 'Bỏ qua bài đang phát'),
  cmd('stop', 'Dừng nhạc, xoá hàng chờ và rời kênh voice'),
  cmd('queue', 'Xem hàng chờ'),
  cmd('nowplaying', 'Xem bài đang phát'),
  cmd('shuffle', 'Trộn hàng chờ'),
  cmd('volume', 'Chỉnh âm lượng').addIntegerOption((o) =>
    o.setName('level').setDescription('Từ 1 đến 150 (mặc định 100)').setRequired(true).setMinValue(1).setMaxValue(150),
  ),
  cmd('loop', 'Chế độ lặp').addStringOption((o) =>
    o
      .setName('mode')
      .setDescription('Chế độ lặp')
      .setRequired(true)
      .addChoices(
        { name: 'Tắt', value: 'off' },
        { name: 'Lặp bài hiện tại', value: 'track' },
        { name: 'Lặp cả hàng chờ', value: 'queue' },
      ),
  ),
  cmd('remove', 'Xoá một bài khỏi hàng chờ').addIntegerOption((o) =>
    o.setName('position').setDescription('Vị trí trong hàng chờ').setRequired(true).setMinValue(1),
  ),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

// ---------- Helpers ----------
const ephemeral = MessageFlags.Ephemeral;
const pad = (n) => String(n).padStart(2, '0');
const safe = (s) => String(s ?? '').replace(/[[\]]/g, '');

function fmt(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const toItem = (t, requester) => ({
  encoded: t.encoded,
  title: t.info.title,
  author: t.info.author,
  uri: t.info.uri,
  length: t.info.length,
  isStream: t.info.isStream,
  artwork: t.info.artworkUrl,
  requester,
});

// ---------- Spotify (chỉ lấy tên bài, sau đó tìm trên YouTube) ----------
let spToken = { value: null, exp: 0 };
async function spotifyToken() {
  if (spToken.value && Date.now() < spToken.exp) return spToken.value;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Đăng nhập Spotify thất bại, kiểm tra lại Client ID / Secret.');
  const json = await res.json();
  spToken = { value: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 };
  return spToken.value;
}

async function spotifyTracks(type, id) {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Bot chưa cấu hình Spotify (thiếu SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).');
  }
  const token = await spotifyToken();
  const get = async (p) => {
    const r = await fetch(`https://api.spotify.com/v1${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error('Không đọc được link Spotify (có thể là playlist riêng tư hoặc bị Spotify giới hạn).');
    return r.json();
  };
  const pick = (t) => (t?.name ? { title: t.name, author: t.artists?.[0]?.name ?? '' } : null);

  if (type === 'track') return [pick(await get(`/tracks/${id}`))].filter(Boolean);
  if (type === 'album') return (await get(`/albums/${id}`)).tracks.items.map(pick).filter(Boolean);
  const p = await get(`/playlists/${id}/tracks?limit=100&fields=items(track(name,artists(name)))`);
  return p.items.map((x) => pick(x.track)).filter(Boolean);
}

// ---------- Tìm nhạc ----------
async function resolveQuery(node, query, userId) {
  const sp = query.match(SPOTIFY_RE);
  if (sp) {
    const list = await spotifyTracks(sp[1], sp[2]);
    // Chưa tìm trên YouTube ngay, đến lượt phát mới tìm (nhanh hơn với playlist dài)
    return list.map((t) => ({
      lazy: true,
      query: `${t.author} - ${t.title}`,
      title: t.title,
      author: t.author,
      requester: userId,
    }));
  }

  const res = await node.rest.resolve(/^https?:\/\//i.test(query) ? query : `ytsearch:${query}`);
  switch (res?.loadType) {
    case 'track':
      return [toItem(res.data, userId)];
    case 'search':
      return res.data.length ? [toItem(res.data[0], userId)] : [];
    case 'playlist':
      return res.data.tracks.map((t) => toItem(t, userId));
    case 'error':
      throw new Error(res.data?.message ?? 'Không tải được nội dung này.');
    default:
      return [];
  }
}

async function materialize(item) {
  const node = shoukaku.getIdealNode();
  if (!node) return null;
  const res = await node.rest.resolve(`ytsearch:${item.query}`).catch(() => null);
  const t = res?.loadType === 'search' ? res.data[0] : null;
  return t ? { ...toItem(t, item.requester), title: item.title, author: item.author } : null;
}

// ---------- Hàng chờ & trình phát ----------
const queues = new Map(); // guildId -> queue

const notify = (q, content) =>
  client.channels.cache.get(q.textChannelId)?.send({ content }).catch(() => {});

async function getOrCreateQueue(i, vc) {
  let q = queues.get(i.guildId);
  if (q) return q;

  const player = await shoukaku.joinVoiceChannel({
    guildId: i.guildId,
    channelId: vc.id,
    shardId: i.guild.shardId,
    deaf: true,
  });

  q = {
    guildId: i.guildId,
    channelId: vc.id,
    textChannelId: i.channelId,
    player,
    current: null,
    tracks: [],
    loop: 'off',
    volume: 100,
    paused: false,
    panel: null,
    starting: false,
    idleTimer: null,
    aloneTimer: null,
    destroyed: false,
  };
  queues.set(i.guildId, q);

  player.on('end', (e) => onEnd(q, e).catch(console.error));
  player.on('exception', (e) =>
    notify(q, `⚠️ Lỗi khi phát **${safe(q.current?.title ?? 'bài hát')}**: ${e?.exception?.message ?? 'không rõ nguyên nhân'}`),
  );
  player.on('stuck', () => {
    notify(q, '⚠️ Bài hát bị đứng, đang bỏ qua...');
    player.stopTrack().catch(() => {});
  });
  return q;
}

async function destroyQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  q.destroyed = true;
  clearTimeout(q.idleTimer);
  clearTimeout(q.aloneTimer);
  queues.delete(guildId);
  await q.panel?.delete().catch(() => {});
  await shoukaku.leaveVoiceChannel(guildId).catch(() => {});
}

async function onEnd(q, e) {
  if (q.destroyed || ['replaced', 'cleanup'].includes(e.reason)) return;
  const prev = q.current;
  if (prev && e.reason !== 'loadFailed') {
    if (q.loop === 'track' && e.reason === 'finished') q.tracks.unshift(prev);
    else if (q.loop === 'queue') q.tracks.push(prev);
  }
  q.current = null;
  await playNext(q);
}

async function playNext(q) {
  if (q.starting || q.destroyed) return;
  q.starting = true;
  clearTimeout(q.idleTimer);
  try {
    while (q.tracks.length) {
      const item = q.tracks.shift();
      const track = item.encoded ? item : await materialize(item);
      if (!track) {
        notify(q, `⚠️ Không tìm thấy **${safe(item.title)}** trên YouTube, bỏ qua.`);
        continue;
      }
      q.current = track;
      try {
        await q.player.playTrack({ track: { encoded: track.encoded } });
        if (q.paused) {
          await q.player.setPaused(false);
          q.paused = false;
        }
        await sendPanel(q);
        return;
      } catch (err) {
        console.error('Không phát được:', err);
        q.current = null;
      }
    }

    // Hết hàng chờ
    q.current = null;
    await clearPanel(q);
    q.idleTimer = setTimeout(() => {
      if (q.current || q.tracks.length) return;
      notify(q, '👋 Hết nhạc rồi, bot rời kênh voice.');
      destroyQueue(q.guildId);
    }, IDLE_MS);
  } finally {
    q.starting = false;
  }
}

// ---------- Bảng điều khiển ----------
function panelPayload(q) {
  const t = q.current;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Đang phát')
    .setDescription(`**[${safe(t.title)}](${t.uri})**\n${t.author}`)
    .addFields(
      { name: 'Thời lượng', value: t.isStream ? 'LIVE' : fmt(t.length), inline: true },
      { name: 'Yêu cầu bởi', value: `<@${t.requester}>`, inline: true },
      { name: 'Hàng chờ', value: `${q.tracks.length} bài`, inline: true },
    )
    .setFooter({ text: `Lặp: ${LOOP_LABEL[q.loop]} • Âm lượng: ${q.volume}%` });
  if (t.artwork) embed.setThumbnail(t.artwork);

  const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
  const row = new ActionRowBuilder().addComponents(
    btn('mu_pause', q.paused ? 'Tiếp tục' : 'Tạm dừng', q.paused ? '▶️' : '⏸️'),
    btn('mu_skip', 'Bỏ qua', '⏭️'),
    btn('mu_loop', 'Lặp', '🔁'),
    btn('mu_shuffle', 'Trộn', '🔀'),
    btn('mu_stop', 'Dừng', '⏹️', ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function clearPanel(q) {
  await q.panel?.delete().catch(() => {});
  q.panel = null;
}

async function sendPanel(q) {
  await clearPanel(q);
  const ch = client.channels.cache.get(q.textChannelId);
  q.panel = (await ch?.send(panelPayload(q)).catch(() => null)) ?? null;
}

const updatePanel = (q) => {
  if (q.current) q.panel?.edit(panelPayload(q)).catch(() => {});
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------- Lệnh ----------
async function requireQueue(i) {
  const q = queues.get(i.guildId);
  if (!q) {
    await i.reply({ content: '❌ Bot chưa phát nhạc.', flags: ephemeral });
    return null;
  }
  if (i.member.voice.channelId !== q.channelId) {
    await i.reply({ content: '❌ Bạn phải ở cùng kênh voice với bot.', flags: ephemeral });
    return null;
  }
  return q;
}

async function play(i) {
  const vc = i.member.voice.channel;
  if (!vc) return i.reply({ content: '❌ Hãy vào một kênh voice trước.', flags: ephemeral });

  const perms = vc.permissionsFor(i.guild.members.me);
  if (!perms?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    return i.reply({ content: '❌ Bot thiếu quyền Connect hoặc Speak trong kênh voice này.', flags: ephemeral });
  }
  const existing = queues.get(i.guildId);
  if (existing && existing.channelId !== vc.id) {
    return i.reply({ content: '❌ Bot đang phát nhạc ở kênh voice khác.', flags: ephemeral });
  }
  const node = shoukaku.getIdealNode();
  if (!node) return i.reply({ content: '❌ Máy chủ nhạc (Lavalink) chưa sẵn sàng, thử lại sau nhé.', flags: ephemeral });

  await i.deferReply();
  let items;
  try {
    items = await resolveQuery(node, i.options.getString('query', true).trim(), i.user.id);
  } catch (err) {
    return i.editReply(`❌ ${err.message}`);
  }
  if (!items.length) return i.editReply('❌ Không tìm thấy kết quả nào.');

  const q = await getOrCreateQueue(i, vc);
  q.textChannelId = i.channelId;
  items = items.slice(0, Math.max(MAX_QUEUE - q.tracks.length, 0));
  if (!items.length) return i.editReply(`❌ Hàng chờ đã đầy (tối đa ${MAX_QUEUE} bài).`);

  clearTimeout(q.idleTimer);
  q.tracks.push(...items);

  const text =
    items.length === 1
      ? `Đã thêm **${safe(items[0].title)}** vào hàng chờ`
      : `Đã thêm **${items.length}** bài vào hàng chờ`;
  await i.editReply({ embeds: [new EmbedBuilder().setColor(COLOR).setDescription(text)] });

  if (!q.current) await playNext(q);
}

const handlers = {
  play,

  async pause(i) {
    const q = await requireQueue(i);
    if (!q) return;
    if (!q.current) return i.reply({ content: '❌ Không có bài nào đang phát.', flags: ephemeral });
    await q.player.setPaused(true);
    q.paused = true;
    updatePanel(q);
    return i.reply({ content: '⏸️ Đã tạm dừng.', flags: ephemeral });
  },

  async resume(i) {
    const q = await requireQueue(i);
    if (!q) return;
    if (!q.current) return i.reply({ content: '❌ Không có bài nào đang phát.', flags: ephemeral });
    await q.player.setPaused(false);
    q.paused = false;
    updatePanel(q);
    return i.reply({ content: '▶️ Đã tiếp tục phát.', flags: ephemeral });
  },

  async skip(i) {
    const q = await requireQueue(i);
    if (!q) return;
    if (!q.current) return i.reply({ content: '❌ Không có bài nào đang phát.', flags: ephemeral });
    await q.player.stopTrack();
    return i.reply({ content: '⏭️ Đã bỏ qua.', flags: ephemeral });
  },

  async stop(i) {
    const q = await requireQueue(i);
    if (!q) return;
    await destroyQueue(i.guildId);
    return i.reply({ content: '⏹️ Đã dừng nhạc và rời kênh voice.', flags: ephemeral });
  },

  async queue(i) {
    const q = await requireQueue(i);
    if (!q) return;
    const lines = q.tracks
      .slice(0, 10)
      .map((t, n) => `**${n + 1}.** ${safe(t.title)} • ${t.author} (${fmt(t.length)})`);
    const more = q.tracks.length > 10 ? `\n...và ${q.tracks.length - 10} bài nữa` : '';
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Hàng chờ')
      .setDescription(
        `${q.current ? `**Đang phát:** ${safe(q.current.title)}\n\n` : ''}${lines.join('\n') || 'Hàng chờ trống.'}${more}`,
      );
    return i.reply({ embeds: [embed], flags: ephemeral });
  },

  async nowplaying(i) {
    const q = await requireQueue(i);
    if (!q) return;
    if (!q.current) return i.reply({ content: '❌ Không có bài nào đang phát.', flags: ephemeral });
    const t = q.current;
    let progress = 'LIVE';
    if (!t.isStream && Number.isFinite(t.length) && t.length > 0) {
      const pos = Number.isFinite(q.player.position) ? q.player.position : 0;
      const n = 15;
      const p = Math.min(n - 1, Math.floor((pos / t.length) * n));
      progress = `${'▬'.repeat(p)}🔘${'▬'.repeat(n - 1 - p)}\n${fmt(pos)} / ${fmt(t.length)}`;
    }
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Đang phát')
      .setDescription(`**[${safe(t.title)}](${t.uri})**\n${t.author}\n\n${progress}`);
    if (t.artwork) embed.setThumbnail(t.artwork);
    return i.reply({ embeds: [embed], flags: ephemeral });
  },

  async shuffle(i) {
    const q = await requireQueue(i);
    if (!q) return;
    if (q.tracks.length < 2) return i.reply({ content: '❌ Hàng chờ chưa đủ bài để trộn.', flags: ephemeral });
    shuffle(q.tracks);
    return i.reply({ content: '🔀 Đã trộn hàng chờ.', flags: ephemeral });
  },

  async volume(i) {
    const q = await requireQueue(i);
    if (!q) return;
    const level = i.options.getInteger('level', true);
    await q.player.setGlobalVolume(level);
    q.volume = level;
    updatePanel(q);
    return i.reply({ content: `🔊 Âm lượng: ${level}%`, flags: ephemeral });
  },

  async loop(i) {
    const q = await requireQueue(i);
    if (!q) return;
    q.loop = i.options.getString('mode', true);
    updatePanel(q);
    return i.reply({ content: `🔁 Chế độ lặp: ${LOOP_LABEL[q.loop]}`, flags: ephemeral });
  },

  async remove(i) {
    const q = await requireQueue(i);
    if (!q) return;
    const pos = i.options.getInteger('position', true);
    if (pos > q.tracks.length) return i.reply({ content: '❌ Không có bài nào ở vị trí đó.', flags: ephemeral });
    const [removed] = q.tracks.splice(pos - 1, 1);
    return i.reply({ content: `🗑️ Đã xoá **${safe(removed.title)}** khỏi hàng chờ.`, flags: ephemeral });
  },
};

// ---------- Nút bấm ----------
async function button(i) {
  const say = (content) => i.reply({ content, flags: ephemeral });
  const q = queues.get(i.guildId);
  if (!q) return say('❌ Bot không còn phát nhạc.');
  if (i.member.voice.channelId !== q.channelId) return say('❌ Bạn phải ở cùng kênh voice với bot.');

  switch (i.customId) {
    case 'mu_pause':
      if (!q.current) return say('❌ Không có bài nào đang phát.');
      await q.player.setPaused(!q.paused);
      q.paused = !q.paused;
      return i.update(panelPayload(q));
    case 'mu_skip':
      await q.player.stopTrack();
      return i.deferUpdate();
    case 'mu_loop':
      q.loop = q.loop === 'off' ? 'track' : q.loop === 'track' ? 'queue' : 'off';
      return q.current ? i.update(panelPayload(q)) : i.deferUpdate();
    case 'mu_shuffle':
      shuffle(q.tracks);
      return say('🔀 Đã trộn hàng chờ.');
    case 'mu_stop':
      await destroyQueue(i.guildId);
      return say('⏹️ Đã dừng nhạc và rời kênh voice.');
  }
}

// ---------- Gợi ý khi gõ /play ----------
async function autocomplete(i) {
  const text = i.options.getFocused().trim();
  if (text.length < 2 || /^https?:\/\//i.test(text)) return i.respond([]);
  const node = shoukaku.getIdealNode();
  if (!node) return i.respond([]);

  const res = await Promise.race([
    node.rest.resolve(`ytsearch:${text}`).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ]);
  if (res?.loadType !== 'search') return i.respond([]);

  return i.respond(
    res.data
      .filter((t) => t.info.uri && t.info.uri.length <= 100)
      .slice(0, 5)
      .map((t) => ({ name: `${t.info.title} - ${t.info.author}`.slice(0, 100), value: t.info.uri })),
  );
}

// ---------- Events ----------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete() && i.commandName === 'play') return await autocomplete(i);
    if (i.isChatInputCommand()) return await handlers[i.commandName]?.(i);
    if (i.isButton() && i.customId.startsWith('mu_')) return await button(i);
  } catch (err) {
    console.error(err);
    if (i.isAutocomplete?.()) return;
    const payload = { content: `❌ Có lỗi xảy ra: ${err.message}` };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => {});
    else await i.reply({ ...payload, flags: ephemeral }).catch(() => {});
  }
});

// Bị kick khỏi kênh voice / không còn ai nghe thì tự rời
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const q = queues.get(oldState.guild.id);
  if (!q) return;

  if (oldState.id === client.user.id) {
    if (!newState.channelId) return destroyQueue(q.guildId);
    q.channelId = newState.channelId; // bot bị kéo sang kênh khác
  }

  const channel = oldState.guild.channels.cache.get(q.channelId);
  const humans = channel?.members.filter((m) => !m.user.bot).size ?? 0;
  clearTimeout(q.aloneTimer);
  if (humans === 0) {
    q.aloneTimer = setTimeout(() => {
      notify(q, '👋 Không còn ai trong kênh voice, bot rời đi.');
      destroyQueue(q.guildId);
    }, ALONE_MS);
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Đăng nhập: ${c.user.tag}`);
  if (GUILD_ID) {
    const guild = await c.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) await guild.commands.set(commands);
    else console.error('❌ GUILD_ID sai hoặc bot chưa ở trong server đó.');
  } else {
    await c.application.commands.set(commands);
  }
  console.log('📌 Đã đăng ký lệnh');
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// Chỉ bật server HTTP khi chạy trên nền tảng có biến PORT (ví dụ Render)
if (process.env.PORT) {
  require('http')
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is alive');
    })
    .listen(process.env.PORT, () => console.log('🌐 HTTP server đang chạy'));
}

client.login(TOKEN);
