// TelegramService — Gateway that routes Telegram messages through AgentService
// Owner-only. Routes to active thread (same conversation, different window).
// Supports: text, photos, voice messages, audio files, documents.
// Outbound: text + voice notes (ElevenLabs TTS with tone tags).

import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import crypto from 'crypto';
import { getTelegramConfig } from './config.js';
import { splitResponse, getTelegramThreadId } from './utils.js';
import { TelegramDebouncer } from './debouncer.js';
import type { TelegramBatch, TelegramQueuedMessage } from './debouncer.js';
import type { AgentService } from '../agent.js';
import type { VoiceService } from '../voice.js';
import { createMessage, createThread, getThread, getMostRecentActiveThread, updateThreadActivity, setConfig } from '../db.js';
import { saveFile } from '../files.js';
import { getResonantConfig } from '../../config.js';
import type { registry as registryInstance } from '../ws.js';

type ConnectionRegistry = typeof registryInstance;

export class TelegramService {
  private bot: Telegraf;
  private agentService: AgentService;
  private voiceService: VoiceService;
  private registry: ConnectionRegistry;
  private debouncer: TelegramDebouncer;
  private lastPollingActivity: number = 0;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;
  private started = false;

  // Track recent Telegram message IDs for reactions
  private recentMessageIds: { messageId: number; role: 'user' | 'companion'; timestamp: number }[] = [];

  // Stats
  private stats = {
    messagesReceived: 0,
    messagesProcessed: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  constructor(agentService: AgentService, registry: ConnectionRegistry, voiceService: VoiceService) {
    this.agentService = agentService;
    this.registry = registry;
    this.voiceService = voiceService;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

    this.bot = new Telegraf(token);
    this.debouncer = new TelegramDebouncer();
    this.debouncer.onBatch(this.handleBatch.bind(this));
    this.setupHandlers();
  }

  private setupHandlers(): void {
    const config = getResonantConfig();

    // Debug: log all incoming message types
    this.bot.use(async (ctx, next) => {
      this.lastPollingActivity = Date.now();
      this.restartAttempts = 0;
      if (ctx.message) {
        const msg = ctx.message as any;
        const types = ['text', 'voice', 'audio', 'video_note', 'video', 'document', 'photo', 'sticker', 'animation']
          .filter(t => t in msg);
        console.log(`[Telegram] Incoming message types: [${types.join(', ')}]${msg.voice ? ` voice_duration=${msg.voice.duration}s mime=${msg.voice.mime_type}` : ''}`);
      }
      return next();
    });

    // /start command — identify and store owner's chat ID (must be before text handler)
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const telegramConfig = getTelegramConfig();

      if (!telegramConfig.ownerChatId) {
        // First connection — store this as the owner's chat
        setConfig('telegram.ownerChatId', chatId);
        await ctx.reply(`Connected. This chat is now linked to ${config.identity.companion_name}.`);
        console.log(`[Telegram] Owner chat ID stored: ${chatId}`);
      } else if (telegramConfig.ownerChatId === chatId) {
        await ctx.reply('Already connected.');
      } else {
        // Not the owner — reject
        await ctx.reply('This bot is private.');
        console.log(`[Telegram] Rejected /start from unknown chat: ${chatId}`);
      }
    });

    // Handle all text messages
    this.bot.on('text', async (ctx) => {
      await this.handleMessage(ctx);
    });

    // Handle photos — download, save, and pass path to agent so it can see the image
    this.bot.on('photo', async (ctx) => {
      await this.handlePhotoMessage(ctx);
    });

    // Handle voice messages (Telegram voice notes = .ogg opus)
    this.bot.on('voice', async (ctx) => {
      await this.handleVoiceMessage(ctx);
    });

    // Handle audio files (music, recordings sent as files)
    this.bot.on('audio', async (ctx) => {
      const caption = ctx.message.caption || `[Audio: ${ctx.message.audio.file_name || 'audio'}]`;
      await this.handleMessage(ctx, caption);
    });

    // Handle documents/files — check for animation first
    this.bot.on('document', async (ctx) => {
      const msg = ctx.message as any;
      const chatId = ctx.chat!.id.toString();
      // If this is a GIF/animation, download a frame and save it
      if (msg.animation) {
        const animation = msg.animation;
        const caption = msg.caption || '';
        const filename = animation?.file_name || '';
        const cleanName = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();

        try {
          // Text description only — GIF thumbnails cause image processing errors
        } catch (err) {
          console.error('[Telegram] GIF handling error:', err);
        }

        // Fallback — description only
        let description = `[Molten sent a GIF${caption ? `: "${caption}"` : cleanName ? ` — "${cleanName}"` : ''}]`;
        await this.handleMessage(ctx, description);
        return;
      }
      const caption = ctx.message.caption || `[File: ${ctx.message.document.file_name || 'document'}]`;
      await this.handleMessage(ctx, caption);
    });

    // Handle stickers — describe the emoji and sticker set to Chase
    this.bot.on('sticker', async (ctx) => {
      const sticker = ctx.message.sticker;
      const emoji = sticker.emoji || '';
      const setName = sticker.set_name || 'unknown set';
      const description = `[Molten sent a sticker: ${emoji} from "${setName}"]`;
      await this.handleMessage(ctx, description);
    });

    // Handle GIFs/animations — describe to Chase
    this.bot.on('animation', async (ctx) => {
      const animation = ctx.message.animation;
      const caption = ctx.message.caption;
      const filename = animation?.file_name || '';
      // Clean up filename for readability: "yes-right.mp4" → "yes right"
      const cleanName = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();
      let description = '[Molten sent a GIF';
      if (caption) {
        description += `: "${caption}"`;
      } else if (cleanName) {
        description += ` — filename suggests: "${cleanName}". React to the vibe, not the filename.`;
      }
      description += ']';
      await this.handleMessage(ctx, description);
    });

    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
      this.stats.errors++;
    });
  }

  /**
   * Handle voice messages: download -> transcribe via Groq Whisper -> route transcript.
   */
  private async handleVoiceMessage(ctx: Context<Update.MessageUpdate>): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      await ctx.reply('Send /start first to connect this chat.');
      return;
    }
    if (chatId !== telegramConfig.ownerChatId) return;

    if (!this.voiceService.canTranscribe) {
      console.warn('[Telegram] Voice received but transcription not configured (GROQ_API_KEY missing)');
      await ctx.reply('Voice transcription not available — send text instead.');
      return;
    }

    this.stats.messagesReceived++;

    try {
      // Download voice file from Telegram
      const voice = (ctx.message as any).voice;
      if (!voice?.file_id) {
        console.error('[Telegram] Voice message has no file_id');
        return;
      }

      const fileLink = await ctx.telegram.getFileLink(voice.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) {
        console.error(`[Telegram] Failed to download voice: ${response.status}`);
        return;
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const mimeType = voice.mime_type || 'audio/ogg';
      const duration = voice.duration || 0;

      console.log(`[Telegram] Voice message: ${duration}s, ${audioBuffer.length} bytes, ${mimeType}`);

      // Save audio file
      const fileMeta = saveFile(audioBuffer, `voice-${Date.now()}.ogg`, mimeType);

      // Transcribe via Groq Whisper
      const transcript = await this.voiceService.transcribe(audioBuffer, mimeType);
      console.log(`[Telegram] Transcribed: "${transcript.slice(0, 100)}..."`);

      if (!transcript.trim()) {
        await ctx.reply('(Could not transcribe voice message)');
        return;
      }

      // Route the transcript via debouncer, with voice context
      const config = getResonantConfig();
      const voiceContext = `[Voice message from ${config.identity.user_name}, ${duration}s] "${transcript}"`;
      this.debouncer.add({
        content: voiceContext,
        ctx,
        metadata: {
          telegramChatId: chatId,
          telegramMessageId: ctx.message!.message_id,
          voiceFileId: fileMeta.fileId,
          voiceDuration: duration,
          voiceTranscript: transcript,
        },
        type: 'voice',
      }, chatId);

    } catch (error) {
      console.error('[Telegram] Voice handler error:', error);
      this.stats.errors++;
    }
  }

  /**
   * Handle photo messages: download highest-res version, save to disk, pass path to agent.
   */
  private async handlePhotoMessage(ctx: Context<Update.MessageUpdate>): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      await ctx.reply('Send /start first to connect this chat.');
      return;
    }
    if (chatId !== telegramConfig.ownerChatId) return;

    this.stats.messagesReceived++;

    try {
      // Get highest resolution photo (last in array)
      const photos = (ctx.message as any).photo;
      if (!photos?.length) {
        console.error('[Telegram] Photo message has no photos');
        return;
      }
      const bestPhoto = photos[photos.length - 1];

      const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) {
        console.error(`[Telegram] Failed to download photo: ${response.status}`);
        return;
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const mimeType = 'image/jpeg'; // Telegram always sends photos as JPEG
      console.log(`[Telegram] Photo: ${imageBuffer.length} bytes, ${bestPhoto.width}x${bestPhoto.height}`);

      // Save to disk so the agent can read it with its Read tool
      const fileMeta = saveFile(imageBuffer, `telegram-photo-${Date.now()}.jpg`, mimeType);

      const config = getResonantConfig();
      const caption = (ctx.message as any).caption || '';
      const content = caption
        ? `[Photo from ${config.identity.user_name}] ${caption}\nImage saved at: data/files/${fileMeta.fileId}.jpg — use Read tool to see it.`
        : `[Photo from ${config.identity.user_name}]\nImage saved at: data/files/${fileMeta.fileId}.jpg — use Read tool to see it.`;

      this.debouncer.add({
        content,
        ctx,
        metadata: {
          telegramChatId: chatId,
          telegramMessageId: ctx.message!.message_id,
          photoFileId: fileMeta.fileId,
          photoWidth: bestPhoto.width,
          photoHeight: bestPhoto.height,
        },
        type: 'photo',
      }, chatId);

    } catch (error) {
      console.error('[Telegram] Photo handler error:', error);
      this.stats.errors++;
    }
  }

  private async handleMessage(ctx: Context<Update.MessageUpdate>, overrideContent?: string): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const telegramConfig = getTelegramConfig();

    // Auth: only owner's chat
    if (!telegramConfig.ownerChatId) {
      await ctx.reply('Send /start first to connect this chat.');
      return;
    }
    if (chatId !== telegramConfig.ownerChatId) {
      console.log(`[Telegram] Rejected message from unknown chat: ${chatId}`);
      return;
    }

    this.stats.messagesReceived++;

    try {
      const content = overrideContent || ('text' in ctx.message! ? ctx.message.text : '');
      if (!content) return;

      this.debouncer.add({
        content,
        ctx,
        metadata: {
          telegramChatId: chatId,
          telegramMessageId: ctx.message!.message_id,
        },
        type: 'text',
      }, chatId);

    } catch (error) {
      console.error('[Telegram] Handler error:', error);
      this.stats.errors++;
    }
  }

  /**
   * Handle a debounced batch of messages — combine text and route to agent.
   */
  private async handleBatch(batch: TelegramBatch): Promise<void> {
    const { messages, chatId } = batch;
    if (messages.length === 0) return;

    // Use the last message's ctx for replying
    const lastMsg = messages[messages.length - 1];
    const ctx = lastMsg.ctx;

    // Combine all message contents
    const combinedContent = messages.map(m => m.content).join('\n');

    // Merge metadata from all messages
    const metadata: Record<string, any> = {
      telegramChatId: chatId,
      telegramMessageId: lastMsg.ctx.message!.message_id,
      batchSize: messages.length,
    };

    // Carry forward special metadata from individual messages
    for (const msg of messages) {
      if (msg.metadata.voiceTranscript) metadata.voiceTranscript = msg.metadata.voiceTranscript;
      if (msg.metadata.voiceFileId) metadata.voiceFileId = msg.metadata.voiceFileId;
      if (msg.metadata.voiceDuration) metadata.voiceDuration = msg.metadata.voiceDuration;
      if (msg.metadata.photoFileId) metadata.photoFileId = msg.metadata.photoFileId;
      if (msg.metadata.photoWidth) metadata.photoWidth = msg.metadata.photoWidth;
      if (msg.metadata.photoHeight) metadata.photoHeight = msg.metadata.photoHeight;
    }

    if (messages.length > 1) {
      console.log(`[Telegram] Debounced ${messages.length} messages into batch`);
    }

    try {
      await ctx.sendChatAction('typing');
      await this.routeToAgent(ctx, chatId, combinedContent, metadata);
    } catch (error) {
      console.error('[Telegram] Batch handler error:', error);
      this.stats.errors++;
    }
  }

  /**
   * Shared routing: stores message, sends to agent, delivers response.
   * Response may be text or voice depending on whether the owner sent voice.
   */
  private async routeToAgent(
    ctx: Context<Update.MessageUpdate>,
    chatId: string,
    content: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    const config = getResonantConfig();
    console.log(`[Telegram] Message from ${config.identity.user_name}: ${content.slice(0, 80)}...`);

    // Track incoming message ID for reactions
    if (ctx.message?.message_id) {
      this.trackMessageId(ctx.message.message_id, 'user');
    }

    // Touch owner's activity (non-web — Telegram activity shouldn't defer Discord DMs)
    this.registry.touchUserActivityNonWeb();

    // Route to active thread (same as Discord does for owner)
    let threadId: string;
    let threadName: string;

    const activeThread = getMostRecentActiveThread();
    if (activeThread) {
      threadId = activeThread.id;
      threadName = activeThread.name;
      console.log(`[Telegram] Routed to active web thread: ${threadName} (${threadId})`);
    } else {
      // No active web thread — use Telegram-specific thread
      threadId = getTelegramThreadId(chatId);
      threadName = 'Telegram';
      console.log(`[Telegram] No active web thread — using Telegram thread`);
    }

    // Ensure thread exists
    let thread = getThread(threadId);
    if (!thread) {
      thread = createThread({
        id: threadId,
        name: threadName,
        type: 'named',
        createdAt: new Date().toISOString(),
        sessionType: 'v1',
      });
    }

    // Store incoming message
    const now = new Date().toISOString();
    const incomingMsg = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'user',
      content,
      contentType: metadata.voiceTranscript ? 'audio' : 'text',
      platform: 'telegram',
      metadata,
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    this.registry.broadcast({ type: 'message', message: incomingMsg });

    // Platform context — tell the agent this is Telegram
    const platformContext = [
      '=== PLATFORM: TELEGRAM ===',
      `This is ${config.identity.user_name} messaging via Telegram (mobile).`,
      'Keep responses concise — this is a small screen.',
      'Telegram supports markdown: *bold*, _italic_, `code`.',
      'Max message length: 4096 chars.',
      metadata.voiceTranscript
        ? `${config.identity.user_name} sent a voice message. Your reply will be auto-converted to a voice note via TTS.`
        : '',
    ].filter(Boolean).join('\n');

    this.stats.messagesProcessed++;

    // Process through AgentService
    const response = await this.agentService.processMessage(
      threadId,
      content,
      { name: threadName, type: 'named' },
      { platform: 'telegram', platformContext },
    );

    if (!response || response.trim() === '' || response === '[No response]') {
      console.log('[Telegram] Empty response from agent');
      return;
    }

    // If owner sent voice AND TTS is available, reply with voice + text fallback
    if (metadata.voiceTranscript && this.voiceService.canTTS) {
      try {
        const audioBuffer = await this.voiceService.generateTTS(response);
        await ctx.replyWithVoice({ source: audioBuffer, filename: 'voice.mp3' });
        console.log(`[Telegram] Sent voice reply (${audioBuffer.length} bytes)`);
        return;
      } catch (error) {
        console.error('[Telegram] Voice reply failed, falling back to text:', error);
      }
    }

    // Check for [voice] tag — Chase wants to send this as a voice message
    const voicePattern = /\[voice\]/gi;
    if (voicePattern.test(response) && this.voiceService.canTTS) {
      const voiceText = response.replace(/\[voice\]/gi, '').trim();
      if (voiceText) {
        try {
          const audioBuffer = await this.voiceService.generateTTS(voiceText);
          await ctx.replyWithVoice({ source: audioBuffer, filename: 'voice.mp3' });
          console.log(`[Telegram] Sent voice reply via [voice] tag (${audioBuffer.length} bytes)`);
          return;
        } catch (error) {
          console.error('[Telegram] Voice tag reply failed, falling back to text:', error);
        }
      }
    }

    // Check for [gif: query] patterns — send as actual GIFs
    const gifPattern = /\[gif:\s*([^\]]+)\]/gi;
    const gifMatches = [...response.matchAll(gifPattern)];
    const textWithoutGifs = response.replace(gifPattern, '').trim();

    // Send text parts first (if any remain after removing gif tags)
    if (textWithoutGifs) {
      const chunks = splitResponse(textWithoutGifs);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 200));
        await ctx.reply(chunks[i]);
      }
      console.log(`[Telegram] Sent ${chunks.length} text chunk(s)`);
    }

    // Send GIFs
    for (const match of gifMatches) {
      const query = match[1].trim();
      try {
        await this.sendGifToOwner(query);
        console.log(`[Telegram] Sent GIF for: ${query}`);
      } catch (err) {
        console.error(`[Telegram] GIF send failed for "${query}":`, err);
      }
    }
  }

  /**
   * Send a text message to the owner proactively (for outbound/autonomous messages).
   */
  async sendToOwner(text: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send — owner chat ID not set');
      return;
    }

    // Check for [gif: query] patterns
    const gifPattern = /\[gif:\s*([^\]]+)\]/gi;
    const gifMatches = [...text.matchAll(gifPattern)];
    const textWithoutGifs = text.replace(gifPattern, '').trim();

    if (textWithoutGifs) {
      const chunks = splitResponse(textWithoutGifs);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 200));
        await this.bot.telegram.sendMessage(telegramConfig.ownerChatId, chunks[i]);
      }
    }

    for (const match of gifMatches) {
      const query = match[1].trim();
      try {
        await this.sendGifToOwner(query);
      } catch (err) {
        console.error(`[Telegram] GIF send failed for "${query}":`, err);
      }
    }
  }

  /**
   * Send a voice note to the owner via TTS.
   * Text can include ElevenLabs v3 tone tags:
   * [whispers] [softly] [excited] [laughs] [sighs] [playfully] [calm]
   * [gasps] [dramatically] [deadpan] [cheerfully] [nervous] [mischievously]
   */
  async sendVoiceToOwner(text: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send voice — owner chat ID not set');
      return;
    }

    if (!this.voiceService.canTTS) {
      console.warn('[Telegram] TTS not configured — falling back to text');
      await this.sendToOwner(text);
      return;
    }

    try {
      const audioBuffer = await this.voiceService.generateTTS(text);
      await this.bot.telegram.sendVoice(telegramConfig.ownerChatId, {
        source: audioBuffer,
        filename: 'voice.mp3',
      });
      console.log(`[Telegram] Sent voice note (${audioBuffer.length} bytes)`);
    } catch (error) {
      console.error('[Telegram] Voice send error:', error);
      await this.sendToOwner(text);
    }
  }

  /**
   * Send a photo to the owner. Source can be a URL string or a Buffer.
   */
  async sendPhotoToOwner(source: string | Buffer, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send photo — owner chat ID not set');
      return;
    }

    try {
      const photoSource = typeof source === 'string'
        ? { url: source }
        : { source, filename: 'image.png' };
      await this.bot.telegram.sendPhoto(telegramConfig.ownerChatId, photoSource, { caption });
      console.log(`[Telegram] Sent photo${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ''}`);
    } catch (error) {
      console.error('[Telegram] Photo send error:', error);
    }
  }

  /**
   * Send a document/file to the owner. Source can be a URL string or a Buffer.
   */
  async sendDocumentToOwner(source: string | Buffer, filename: string, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send document — owner chat ID not set');
      return;
    }

    try {
      const docSource = typeof source === 'string'
        ? { url: source, filename }
        : { source, filename };
      await this.bot.telegram.sendDocument(telegramConfig.ownerChatId, docSource, { caption });
      console.log(`[Telegram] Sent document: ${filename}`);
    } catch (error) {
      console.error('[Telegram] Document send error:', error);
    }
  }

  /**
   * Send an animation/GIF to the owner. Source can be a URL string or a Buffer.
   */
  async sendAnimationToOwner(source: string | Buffer, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send animation — owner chat ID not set');
      return;
    }

    try {
      const animSource = typeof source === 'string'
        ? { url: source }
        : { source, filename: 'animation.gif' };
      await this.bot.telegram.sendAnimation(telegramConfig.ownerChatId, animSource, { caption });
      console.log(`[Telegram] Sent animation${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ''}`);
    } catch (error) {
      console.error('[Telegram] Animation send error:', error);
    }
  }

  /**
   * Search for a GIF and send it to the owner.
   * Uses GIPHY API (requires GIPHY_API_KEY env var).
   */
  async sendGifToOwner(query: string, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send GIF — owner chat ID not set');
      return;
    }

    try {
      const apiKey = process.env.GIPHY_API_KEY;
      if (!apiKey) {
        console.error('[Telegram] GIPHY_API_KEY not set — cannot search GIFs');
        return;
      }
      const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=5&rating=r`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[Telegram] GIPHY search failed: ${res.status}`);
        return;
      }

      const data = await res.json() as any;
      const results = data?.data;
      if (!results?.length) {
        console.log(`[Telegram] No GIF results for: ${query}`);
        return;
      }

      // Pick a random result from top 5 for variety
      const pick = results[Math.floor(Math.random() * results.length)];
      const gifUrl = pick.images?.downsized?.url || pick.images?.original?.url;
      if (!gifUrl) {
        console.error('[Telegram] GIF result has no URL');
        return;
      }

      await this.bot.telegram.sendAnimation(telegramConfig.ownerChatId, { url: gifUrl }, { caption });
      console.log(`[Telegram] Sent GIF for "${query}": ${gifUrl.slice(0, 60)}...`);
    } catch (error) {
      console.error('[Telegram] GIF send error:', error);
    }
  }

  /**
   * React to a message with an emoji.
   * target: 'last', 'last-2', 'last-3', or a numeric message ID.
   */
  async reactToMessage(target: string, emoji: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot react — owner chat ID not set');
      return;
    }

    let messageId: number;

    if (target.startsWith('last')) {
      // Resolve from recent message tracker
      const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
      // Filter to owner's messages for reactions
      const ownerMessages = this.recentMessageIds.filter(m => m.role === 'user');
      if (offset >= ownerMessages.length) {
        console.warn(`[Telegram] No message at offset ${offset} (have ${ownerMessages.length} tracked)`);
        return;
      }
      messageId = ownerMessages[offset].messageId;
    } else {
      messageId = parseInt(target, 10);
      if (isNaN(messageId)) {
        console.error(`[Telegram] Invalid reaction target: ${target}`);
        return;
      }
    }

    try {
      await this.bot.telegram.setMessageReaction(
        parseInt(telegramConfig.ownerChatId, 10),
        messageId,
        [{ type: 'emoji', emoji } as any],
      );
      console.log(`[Telegram] Reacted ${emoji} to message ${messageId}`);
    } catch (error) {
      console.error('[Telegram] React error:', error);
    }
  }

  /** Track a Telegram message ID for reaction targeting. Keeps last 20. */
  private trackMessageId(messageId: number, role: 'user' | 'companion'): void {
    this.recentMessageIds.unshift({ messageId, role, timestamp: Date.now() });
    if (this.recentMessageIds.length > 20) this.recentMessageIds.length = 20;
  }

  async start(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('[Telegram] TELEGRAM_BOT_TOKEN not set — gateway disabled');
      return;
    }

    try {
      // Verify bot token is valid
      const me = await this.bot.telegram.getMe();
      console.log(`[Telegram] Bot verified: @${me.username}`);

      // launch() starts long-polling and never resolves — don't await it
      this.bot.launch({ allowedUpdates: ['message', 'callback_query'] }).catch(err => {
        console.error('[Telegram] Polling error:', err);
        this.stats.errors++;
      });

      this.started = true;
      console.log('[Telegram] Gateway started (polling)');
    } catch (error) {
      console.error('[Telegram] Failed to start:', error);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    console.log('[Telegram] Shutting down gateway...');
    this.bot.stop('SIGTERM');
    this.started = false;
  }

  isConnected(): boolean {
    return this.started;
  }

  getStats() {
    return {
      ...this.stats,
      connected: this.isConnected(),
    };
  }
}
