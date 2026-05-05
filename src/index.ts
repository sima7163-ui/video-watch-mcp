import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  Partials,
  AttachmentBuilder,
  TextChannel,
  Guild,
  GuildBasedChannel,
  PresenceStatusData,
  MessageCreateOptions,
  MessageFlags,
} from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import axios from 'axios';
import FormData from 'form-data';

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ElevenLabsConfig {
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
}

interface AppConfig {
  elevenlabs?: ElevenLabsConfig;
  defaults?: { guildId?: string };
}

let config: AppConfig = {};
const configPath = path.join(process.cwd(), 'config.json');
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN environment variable is required');
}

const hasElevenLabs = !!(ELEVENLABS_API_KEY && config.elevenlabs?.voiceId);

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

function resolveGuild(serverId?: string): Guild | undefined {
  const id = serverId ?? config.defaults?.guildId;
  if (id) return discordClient.guilds.cache.get(id);
  if (discordClient.guilds.cache.size === 1) return discordClient.guilds.cache.first();
  return undefined;
}

function resolveChannel(guild: Guild, channelIdOrName: string): GuildBasedChannel | undefined {
  return (
    guild.channels.cache.get(channelIdOrName) ??
    guild.channels.cache.find((c) => c.name === channelIdOrName)
  );
}

async function getTextChannel(args: Record<string, unknown>): Promise<TextChannel> {
  const guild = resolveGuild(args.server as string | undefined);
  if (!guild) {
    throw new Error(
      'Could not resolve server. Provide a server ID or set defaults.guildId in config.json.',
    );
  }
  const ch = resolveChannel(guild, args.channel as string);
  if (!ch) throw new Error(`Channel "${args.channel}" not found`);
  if (!ch.isTextBased()) throw new Error(`Channel "${args.channel}" is not a text channel`);
  return ch as TextChannel;
}

function resolveMessageEmojis(guild: Guild, text: string): string {
  return text.replace(/:([a-zA-Z0-9_]+):/g, (match, name) => {
    const emoji = guild.emojis.cache.find((e) => e.name === name);
    if (!emoji) return match;
    return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
  });
}

function resolveReactionEmoji(guild: Guild, emoji: string): string {
  const name = emoji.startsWith(':') && emoji.endsWith(':') ? emoji.slice(1, -1) : emoji;
  const found = guild.emojis.cache.find((e) => e.name === name);
  if (found) return `${found.name}:${found.id}`;
  return emoji;
}

async function loadAttachment(source: string, filename: string): Promise<AttachmentBuilder> {
  if (/^https?:\/\//i.test(source)) {
    const response = await axios.get<ArrayBuffer>(source, { responseType: 'arraybuffer' });
    return new AttachmentBuilder(Buffer.from(response.data), { name: filename });
  }
  return new AttachmentBuilder(source, { name: filename });
}

// ---------------------------------------------------------------------------
// Voice note pipeline
// ---------------------------------------------------------------------------

function spawnFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // ffmpeg-static returns the path to the bundled binary
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegBin: string = require('ffmpeg-static');
    const proc = childProcess.spawn(ffmpegBin, args);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    proc.stderr.on('data', () => {}); // suppress ffmpeg stderr
    proc.on('error', reject);
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

async function mp3ToOgg(mp3: Buffer): Promise<Buffer> {
  return spawnFfmpeg(
    [
      '-f', 'mp3', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1',
      '-f', 'ogg', 'pipe:1',
    ],
    mp3,
  );
}

async function mp3ToPcm(mp3: Buffer): Promise<Buffer> {
  return spawnFfmpeg(
    [
      '-f', 'mp3', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      'pipe:1',
    ],
    mp3,
  );
}

function computeWaveform(pcm: Buffer): { waveform: string; durationSecs: number } {
  const totalSamples = pcm.length / 2; // s16le = 2 bytes per sample
  const durationSecs = totalSamples / 16000;
  const peaks = new Uint8Array(256);
  const chunkSize = Math.max(1, Math.floor(totalSamples / 256));

  for (let i = 0; i < 256; i++) {
    let max = 0;
    for (let j = 0; j < chunkSize; j++) {
      const byteIdx = (i * chunkSize + j) * 2;
      if (byteIdx + 1 >= pcm.length) break;
      const sample = Math.abs(pcm.readInt16LE(byteIdx));
      if (sample > max) max = sample;
    }
    peaks[i] = max;
  }

  const maxVal = Math.max(...peaks);
  if (maxVal > 0) {
    for (let i = 0; i < 256; i++) {
      peaks[i] = Math.round((peaks[i] / maxVal) * 255);
    }
  }

  return { waveform: Buffer.from(peaks).toString('base64'), durationSecs };
}

async function elevenLabsTts(text: string): Promise<Buffer> {
  const el = config.elevenlabs!;
  const response = await axios.post<ArrayBuffer>(
    `https://api.elevenlabs.io/v1/text-to-speech/${el.voiceId}`,
    {
      text,
      model_id: el.modelId,
      voice_settings: {
        stability: el.stability,
        similarity_boost: el.similarityBoost,
        style: el.style,
        use_speaker_boost: el.useSpeakerBoost,
      },
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
    },
  );
  return Buffer.from(response.data);
}

async function sendVoiceNote(channelId: string, text: string): Promise<void> {
  const mp3 = await elevenLabsTts(text);
  const [ogg, pcm] = await Promise.all([mp3ToOgg(mp3), mp3ToPcm(mp3)]);
  const { waveform, durationSecs } = computeWaveform(pcm);

  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      flags: MessageFlags.IsVoiceMessage,
      attachments: [
        {
          id: '0',
          filename: 'voice-message.ogg',
          duration_secs: durationSecs,
          waveform,
        },
      ],
    }),
  );
  form.append('files[0]', ogg, { filename: 'voice-message.ogg', contentType: 'audio/ogg' });

  await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bot ${DISCORD_TOKEN}` },
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const BASE_TOOLS: Tool[] = [
  {
    name: 'send_message',
    description:
      'Send a text message to a Discord channel. Use :emoji_name: to insert custom server emojis.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        message: { type: 'string', description: 'Message text' },
        reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'message'],
    },
  },
  {
    name: 'read_messages',
    description: 'Read recent messages from a Discord channel with full metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        limit: { type: 'number', description: 'Number of messages to fetch (1-100, default 10)' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message sent by the bot.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        message_id: { type: 'string', description: 'ID of the message to edit' },
        new_content: { type: 'string', description: 'New message content' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'message_id', 'new_content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message in a Discord channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        message_id: { type: 'string', description: 'ID of the message to delete' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'message_id'],
    },
  },
  {
    name: 'react_to_message',
    description: 'Add a reaction to a message. Accepts unicode emoji or :custom_emoji_name:.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        message_id: { type: 'string', description: 'ID of the message to react to' },
        emoji: { type: 'string', description: 'Emoji to react with (unicode or :name:)' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'message_id', 'emoji'],
    },
  },
  {
    name: 'set_typing',
    description: 'Show typing indicator in a channel for ~10 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'send_image',
    description: 'Send an image to a Discord channel (local file path or URL).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        source: { type: 'string', description: 'Local file path or URL of the image' },
        caption: { type: 'string', description: 'Optional caption text' },
        filename: { type: 'string', description: 'Filename to use (default: image.png)' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'source'],
    },
  },
  {
    name: 'send_file',
    description: 'Send a file to a Discord channel (local file path or URL).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        source: { type: 'string', description: 'Local file path or URL of the file' },
        caption: { type: 'string', description: 'Optional caption text' },
        filename: { type: 'string', description: 'Filename to use (default: file)' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'source'],
    },
  },
  {
    name: 'send_sticker',
    description: 'Send a server sticker by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name' },
        sticker_id: { type: 'string', description: 'Sticker ID' },
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
      required: ['channel', 'sticker_id'],
    },
  },
  {
    name: 'list_servers',
    description: 'List all Discord servers the bot is in.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_channels',
    description: 'List channels in a Discord server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
    },
  },
  {
    name: 'list_emojis',
    description: 'List custom emojis available in a Discord server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
    },
  },
  {
    name: 'list_stickers',
    description: 'List stickers available in a Discord server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server/guild ID (optional)' },
      },
    },
  },
  {
    name: 'set_status',
    description: "Set the bot's presence status and activity.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['online', 'idle', 'dnd', 'invisible'],
          description: 'Presence status',
        },
        activity: { type: 'string', description: 'Activity text (optional)' },
        activity_type: {
          type: 'string',
          enum: ['Playing', 'Streaming', 'Listening', 'Watching', 'Competing'],
          description: 'Activity type (default: Playing)',
        },
      },
      required: ['status'],
    },
  },
];

const VOICE_NOTE_TOOL: Tool = {
  name: 'send_voice_note',
  description:
    'Convert text to speech with ElevenLabs and send it as a real Discord voice message.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID or name' },
      text: { type: 'string', description: 'Text to convert to speech' },
      server: { type: 'string', description: 'Server/guild ID (optional)' },
    },
    required: ['channel', 'text'],
  },
};

const TOOLS: Tool[] = hasElevenLabs ? [...BASE_TOOLS, VOICE_NOTE_TOOL] : BASE_TOOLS;

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

async function handleSendMessage(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const guild = ch.guild;
  const content = resolveMessageEmojis(guild, args.message as string);
  const opts: MessageCreateOptions = { content };
  if (args.reply_to) {
    opts.reply = { messageReference: args.reply_to as string };
  }
  const msg = await ch.send(opts);
  return `Message sent (ID: ${msg.id})`;
}

async function handleReadMessages(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 10)));
  const messages = await ch.messages.fetch({ limit });
  const result = messages
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => ({
      id: m.id,
      author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      edited: m.editedAt?.toISOString() ?? null,
      attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, url: a.url })),
      embeds: m.embeds.map((e) => ({ title: e.title, description: e.description, url: e.url })),
      stickers: m.stickers.map((s) => ({ id: s.id, name: s.name })),
      reactions: m.reactions.cache.map((r) => ({
        emoji: r.emoji.toString(),
        count: r.count,
      })),
      reply_to: m.reference?.messageId ?? null,
    }));
  return JSON.stringify(result, null, 2);
}

async function handleEditMessage(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const msg = await ch.messages.fetch(args.message_id as string);
  const guild = ch.guild;
  const newContent = resolveMessageEmojis(guild, args.new_content as string);
  await msg.edit(newContent);
  return `Message ${msg.id} edited`;
}

async function handleDeleteMessage(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const msg = await ch.messages.fetch(args.message_id as string);
  await msg.delete();
  return `Message ${args.message_id} deleted`;
}

async function handleReactToMessage(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const guild = ch.guild;
  const msg = await ch.messages.fetch(args.message_id as string);
  const emoji = resolveReactionEmoji(guild, args.emoji as string);
  await msg.react(emoji);
  return `Reacted with ${args.emoji}`;
}

async function handleSetTyping(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  await ch.sendTyping();
  return 'Typing indicator set';
}

async function handleSendImage(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const filename = (args.filename as string | undefined) ?? 'image.png';
  const attachment = await loadAttachment(args.source as string, filename);
  const opts: MessageCreateOptions = { files: [attachment] };
  if (args.caption) opts.content = args.caption as string;
  const msg = await ch.send(opts);
  return `Image sent (ID: ${msg.id})`;
}

async function handleSendFile(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const source = args.source as string;
  const basename = path.basename(source).replace(/[?#].*$/, '') || 'file';
  const filename = (args.filename as string | undefined) ?? basename;
  const attachment = await loadAttachment(source, filename);
  const opts: MessageCreateOptions = { files: [attachment] };
  if (args.caption) opts.content = args.caption as string;
  const msg = await ch.send(opts);
  return `File sent (ID: ${msg.id})`;
}

async function handleSendSticker(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  const msg = await ch.send({ stickers: [args.sticker_id as string] });
  return `Sticker sent (ID: ${msg.id})`;
}

async function handleListServers(): Promise<string> {
  const servers = discordClient.guilds.cache.map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g.memberCount,
    channelCount: g.channels.cache.size,
  }));
  return JSON.stringify(servers, null, 2);
}

async function handleListChannels(args: Args): Promise<string> {
  const guild = resolveGuild(args.server as string | undefined);
  if (!guild) throw new Error('Could not resolve server');
  const channels = guild.channels.cache.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    position: 'position' in c ? (c as { position: number }).position : null,
    topic: 'topic' in c ? (c as { topic: string | null }).topic : null,
  }));
  channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return JSON.stringify(channels, null, 2);
}

async function handleListEmojis(args: Args): Promise<string> {
  const guild = resolveGuild(args.server as string | undefined);
  if (!guild) throw new Error('Could not resolve server');
  const emojis = guild.emojis.cache.map((e) => ({
    id: e.id,
    name: e.name,
    animated: e.animated ?? false,
    usage: e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`,
    shortcode: `:${e.name}:`,
  }));
  return JSON.stringify(emojis, null, 2);
}

async function handleListStickers(args: Args): Promise<string> {
  const guild = resolveGuild(args.server as string | undefined);
  if (!guild) throw new Error('Could not resolve server');
  const stickers = guild.stickers.cache.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    formatType: s.format,
  }));
  return JSON.stringify(stickers, null, 2);
}

async function handleSetStatus(args: Args): Promise<string> {
  const status = args.status as PresenceStatusData;
  const activityTypeMap: Record<string, ActivityType> = {
    Playing: ActivityType.Playing,
    Streaming: ActivityType.Streaming,
    Listening: ActivityType.Listening,
    Watching: ActivityType.Watching,
    Competing: ActivityType.Competing,
  };
  const activityType =
    activityTypeMap[(args.activity_type as string | undefined) ?? 'Playing'] ?? ActivityType.Playing;

  discordClient.user!.setPresence({
    status,
    activities: args.activity
      ? [{ name: args.activity as string, type: activityType }]
      : [],
  });
  return `Status set to ${status}${args.activity ? ` (${args.activity_type ?? 'Playing'} ${args.activity})` : ''}`;
}

async function handleSendVoiceNote(args: Args): Promise<string> {
  const ch = await getTextChannel(args);
  await sendVoiceNote(ch.id, args.text as string);
  return 'Voice note sent';
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'discord-claude-full-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Args;

  try {
    let text: string;
    switch (name) {
      case 'send_message':       text = await handleSendMessage(a); break;
      case 'read_messages':      text = await handleReadMessages(a); break;
      case 'edit_message':       text = await handleEditMessage(a); break;
      case 'delete_message':     text = await handleDeleteMessage(a); break;
      case 'react_to_message':   text = await handleReactToMessage(a); break;
      case 'set_typing':         text = await handleSetTyping(a); break;
      case 'send_image':         text = await handleSendImage(a); break;
      case 'send_file':          text = await handleSendFile(a); break;
      case 'send_sticker':       text = await handleSendSticker(a); break;
      case 'list_servers':       text = await handleListServers(); break;
      case 'list_channels':      text = await handleListChannels(a); break;
      case 'list_emojis':        text = await handleListEmojis(a); break;
      case 'list_stickers':      text = await handleListStickers(a); break;
      case 'set_status':         text = await handleSetStatus(a); break;
      case 'send_voice_note':    text = await handleSendVoiceNote(a); break;
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return { content: [{ type: 'text' as const, text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await discordClient.login(DISCORD_TOKEN);
  await new Promise<void>((resolve) => discordClient.once('ready', () => resolve()));
  console.error(`Discord bot ready as ${discordClient.user?.tag}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
