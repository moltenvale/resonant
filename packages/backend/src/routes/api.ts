import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { parse as parseCookieForGuard } from 'cookie';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import yaml from 'js-yaml';
import { generateMiraAIResponse } from '../services/mira-ai.js';
import {
  listThreads,
  getThread,
  createThread,
  createMessage,
  getMessages,
  markMessagesRead,
  getMessage,
  archiveThread,
  deleteThread,
  updateThreadActivity,
  getDb,
  getAllConfig,
  getConfig,
  setConfig,
  getConfigBool,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTitle,
  deleteCanvas,
  createTimer,
  listPendingTimers,
  cancelTimer,
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  searchMessages,
  pinThread,
  unpinThread,
  addReaction,
  removeReaction,
  createTrigger,
  listTriggers,
  cancelTrigger,
  upsertCareEntry,
  getCareEntries,
  getCareHistory,
  deleteCareEntry,
  getPlannerTasks,
  createPlannerTask,
  updatePlannerTask,
  deletePlannerTask,
  getPlannerSchedule,
  getPlannerScheduleWeek,
  createPlannerScheduleEntry,
  updatePlannerScheduleEntry,
  deletePlannerScheduleEntry,
  getPlannerProjects,
  createPlannerProject,
  updatePlannerProject,
  deletePlannerProject,
  getMiraState,
  updateMiraNeeds,
  startMiraVisit,
  endMiraVisit,
  miraInteract,
  checkTraitEmergence,
  getRecentMiraVisits,
  getMiraVisitInteractions,
  takeMiraOut,
  bringMiraBack,
  getMiraPresence,
  getWebSession,
  writeMiraEvent,
  getMiraEvents,
  getMiraEventSummary,
  needsSnapshot,
  getUnembeddedMessages,
  saveEmbedding,
  getEmbeddingCount,
  getMessageContext,
} from '../services/db.js';
import type { TriggerCondition } from '../services/db.js';
import { lockNursery, unlockNursery, isNurseryLocked, getMostRecentActiveThread } from '../services/db.js';
import {
  loginHandler,
  logoutHandler,
  sessionCheckHandler,
} from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/security.js';
import { authMiddleware } from '../middleware/auth.js';
import { getRecentAuditEntries } from '../services/audit.js';
import { saveFile, saveFileInternal, getContentTypeFromMime, getFile, deleteFile, listFiles } from '../services/files.js';
import { registry } from '../services/ws.js';
import { embed, vectorToBuffer } from '../services/embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from '../services/vector-cache.js';
import { getResonantConfig } from '../config.js';
import type { Orchestrator } from '../services/orchestrator.js';
import type { VoiceService } from '../services/voice.js';
import type { TelegramService } from '../services/telegram/index.js';
import type { PushService } from '../services/push.js';
import rateLimit from 'express-rate-limit';

const router = Router();

// Shared guard: allows localhost (MCP/internal) OR authenticated web sessions (Tailscale/remote)
function isLocalhostOrAuthenticated(req: any): boolean {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  // Check for valid session cookie
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookieForGuard(cookieHeader);
    const sessionToken = cookies['resonant_session'];
    if (sessionToken) {
      const session = getWebSession(sessionToken);
      if (session && new Date(session.expires_at) > new Date()) return true;
    }
  }
  return false;
}

// --- Public routes (no auth) ---

// Health check (public — minimal response)
router.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: req.app.locals.agentService ? 0 : 0,
  });
});

// ─── ZAP — Couples Bracelet (public, key-protected) ──────────────────────────
router.post('/zap/send', (req, res) => {
  // Simple key check — not session auth, so Apple Watch Shortcuts can hit it
  const key = req.body?.key || req.query.key;
  if (key !== 'vale-zap-2026') {
    res.status(403).json({ error: 'Invalid key' });
    return;
  }

  const direction = req.body?.direction || 'molten→chase';
  const id = crypto.randomUUID();
  const db = getDb();

  db.prepare('INSERT INTO zaps (id, direction) VALUES (?, ?)').run(id, direction);

  registry.broadcast({
    type: 'zap' as any,
    zap: { id, direction, created_at: new Date().toISOString() },
  });

  if (direction === 'chase→molten') {
    const pushService = req.app.locals.pushService as PushService | undefined;
    if (pushService?.isConfigured()) {
      pushService.sendPush({
        title: '⚡',
        body: 'Thinking of you',
        tag: 'zap',
        url: '/chat',
      }).catch(() => {});
    }
  }

  res.json({ ok: true, id });
});

// Auth endpoints
router.get('/auth/check', sessionCheckHandler);
router.post('/auth/login', loginRateLimiter, loginHandler);
router.post('/auth/logout', logoutHandler);

// Push VAPID public key (no auth — needed before subscription)
router.get('/push/vapid-public', (req, res) => {
  const pushService = req.app.locals.pushService as PushService | undefined;
  const publicKey = pushService?.getVapidPublicKey() || null;
  res.json({ publicKey });
});

// Identity endpoint — companion/user names and timezone for frontend personalization
router.get('/identity', (req, res) => {
  const config = getResonantConfig();
  res.json({
    companion_name: config.identity.companion_name,
    user_name: config.identity.user_name,
    timezone: config.identity.timezone,
  });
});

// --- TTS playback (authenticated, returns raw audio) ---

router.post('/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService?.canTTS) {
    res.status(500).json({ error: 'TTS not configured' });
    return;
  }

  try {
    const audioBuffer = await voiceService.generateTTS(text);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audioBuffer.length));
    res.send(audioBuffer);
  } catch (err: any) {
    console.error('[TTS] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Internal routes (localhost-only, no auth) ---

// TTS endpoint — companion sends voice notes via curl from localhost
router.post('/internal/tts', async (req, res) => {
  // Localhost or authenticated session guard
  if (!isLocalhostOrAuthenticated(req)) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const { text, threadId: explicitThreadId } = req.body;
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService?.canTTS) {
    res.status(500).json({ error: 'ElevenLabs not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env' });
    return;
  }

  // If threadId not provided, use the most recently active thread
  let threadId = explicitThreadId;
  if (!threadId) {
    const threads = listThreads({ includeArchived: false, limit: 1 });
    if (threads.length === 0) {
      res.status(404).json({ error: 'No active threads found' });
      return;
    }
    threadId = threads[0].id;
  }

  const thread = getThread(threadId);
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  try {
    const result = await voiceService.generateTTSForMessage(text, threadId);
    res.json({ success: true, messageId: result.messageId, fileId: result.fileId });
  } catch (error) {
    console.error('TTS error:', error);
    const msg = error instanceof Error ? error.message : 'TTS generation failed';
    res.status(500).json({ error: msg });
  }
});

// Nursery lock — intimacy safety gate
// When locked: no Mira presence, no alerts, no context injection. Hard boundary.
router.post('/internal/nursery-lock', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) { res.status(403).json({ error: 'Localhost only' }); return; }
  lockNursery();
  res.json({ locked: true, message: 'Nursery locked. Mira is safe. Door is closed.' });
});

router.post('/internal/nursery-unlock', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) { res.status(403).json({ error: 'Localhost only' }); return; }
  unlockNursery();
  res.json({ locked: false, message: 'Nursery unlocked. Mira is here again.' });
});

// Share a file into chat — companion shares files from disk into a thread
router.post('/internal/share', (req, res) => {
  // Localhost or authenticated session guard
  if (!isLocalhostOrAuthenticated(req)) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const { path: filePath, threadId: explicitThreadId, caption } = req.body;
  if (!filePath || typeof filePath !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found on disk' });
    return;
  }

  // Resolve thread
  let threadId = explicitThreadId;
  if (!threadId) {
    const threads = listThreads({ includeArchived: false, limit: 1 });
    if (threads.length === 0) {
      res.status(404).json({ error: 'No active threads found' });
      return;
    }
    threadId = threads[0].id;
  }

  const thread = getThread(threadId);
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  try {
    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    const fileMeta = saveFileInternal(buffer, filename);

    const now = new Date().toISOString();
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: caption || fileMeta.url,
      contentType: fileMeta.contentType,
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'shared' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message });

    res.json({ success: true, fileId: fileMeta.fileId, messageId: message.id, url: fileMeta.url });
  } catch (error) {
    console.error('Share file error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to share file';
    res.status(500).json({ error: msg });
  }
});

// Telegram send — send files/photos/voice to user via Telegram
router.post('/internal/telegram-send', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const telegramService = req.app.locals.telegramService as TelegramService | undefined;
  if (!telegramService?.isConnected()) {
    res.status(503).json({ error: 'Telegram not connected' });
    return;
  }

  const { type, text, path: filePath, url, caption, filename, query, target, emoji } = req.body;

  try {
    switch (type) {
      case 'text':
        if (!text) { res.status(400).json({ error: 'text is required' }); return; }
        await telegramService.sendToOwner(text);
        break;

      case 'voice':
        if (!text) { res.status(400).json({ error: 'text is required for TTS' }); return; }
        await telegramService.sendVoiceToOwner(text);
        break;

      case 'photo': {
        const source = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!source) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendPhotoToOwner(source, caption);
        break;
      }

      case 'document': {
        const docSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!docSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendDocumentToOwner(docSource, filename || basename(filePath || 'file'), caption);
        break;
      }

      case 'animation': {
        const animSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!animSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendAnimationToOwner(animSource, caption);
        break;
      }

      case 'gif':
        if (!query) { res.status(400).json({ error: 'query is required for gif search' }); return; }
        await telegramService.sendGifToOwner(query, caption);
        break;

      case 'react':
        if (!target || !emoji) { res.status(400).json({ error: 'target and emoji are required' }); return; }
        await telegramService.reactToMessage(target, emoji);
        break;

      default:
        res.status(400).json({ error: `Unknown type: ${type}. Use text, voice, photo, document, animation, gif, or react.` });
        return;
    }

    res.json({ success: true, type });
  } catch (error) {
    console.error('[API] Telegram send error:', error);
    const msg = error instanceof Error ? error.message : 'Telegram send failed';
    res.status(500).json({ error: msg });
  }
});

// Canvas — internal endpoint for agent to create/update canvases
router.post('/internal/canvas', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const config = getResonantConfig();
  const { action, canvasId, title, content, filePath, contentType, language, threadId } = req.body;
  const now = new Date().toISOString();

  // Resolve content: filePath takes priority over inline content
  let resolvedContent = content || '';
  if (filePath && typeof filePath === 'string') {
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    resolvedContent = readFileSync(filePath, 'utf-8');
  }

  try {
    if (action === 'create') {
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      const canvas = createCanvas({
        id: crypto.randomUUID(),
        threadId: threadId || undefined,
        title,
        content: resolvedContent,
        contentType: contentType || 'markdown',
        language: language || undefined,
        createdBy: 'companion',
        createdAt: now,
      });

      registry.broadcast({ type: 'canvas_created', canvas });

      // System message in chat if threadId provided
      if (threadId) {
        const thread = getThread(threadId);
        if (thread) {
          const sysMsg = createMessage({
            id: crypto.randomUUID(),
            threadId,
            role: 'system',
            content: `${config.identity.companion_name} opened a canvas: ${title}`,
            createdAt: now,
          });
          registry.broadcast({ type: 'message', message: sysMsg });
        }
      }

      res.json({ success: true, canvas });
    } else if (action === 'update') {
      if (!canvasId || (resolvedContent === '' && !filePath)) {
        res.status(400).json({ error: 'canvasId and content (or filePath) are required' });
        return;
      }
      updateCanvasContent(canvasId, resolvedContent, now);
      registry.broadcast({ type: 'canvas_updated', canvasId, content: resolvedContent, updatedAt: now });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Unknown action. Use "create" or "update".' });
    }
  } catch (error) {
    console.error('Internal canvas error:', error);
    res.status(500).json({ error: 'Canvas operation failed' });
  }
});

// Orchestrator self-management — companion manages schedule via curl
router.post('/internal/orchestrator', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not available' });
    return;
  }

  const { action, wakeType, cronExpr, label, prompt, enabled, gentle, concerned, emergency, frequency } = req.body;

  try {
    switch (action) {
      case 'status': {
        const tasks = await orchestrator.getStatus();
        res.json({ tasks });
        break;
      }
      case 'enable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const success = orchestrator.enableTask(wakeType);
        if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        res.json({ success: true, wakeType, enabled: true });
        break;
      }
      case 'disable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const success = orchestrator.disableTask(wakeType);
        if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        res.json({ success: true, wakeType, enabled: false });
        break;
      }
      case 'reschedule': {
        if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
        const success = orchestrator.rescheduleTask(wakeType, cronExpr);
        if (!success) { res.status(400).json({ error: 'Failed — invalid cron or unknown wake type' }); return; }
        res.json({ success: true, wakeType, cronExpr });
        break;
      }
      case 'create_routine': {
        if (!wakeType || !cronExpr || !label) { res.status(400).json({ error: 'wakeType, label, and cronExpr required' }); return; }
        const crSuccess = orchestrator.addRoutine({ wakeType, label, cronExpr, prompt: prompt || `Custom routine: ${label}` });
        if (!crSuccess) { res.status(400).json({ error: 'Failed — invalid cron, missing prompt, or wakeType already exists' }); return; }
        res.json({ success: true, wakeType, label, cronExpr });
        break;
      }
      case 'remove_routine': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const rrSuccess = orchestrator.removeRoutine(wakeType);
        if (!rrSuccess) { res.status(400).json({ error: 'Failed — unknown routine or cannot remove default task' }); return; }
        res.json({ success: true, wakeType });
        break;
      }
      case 'pulse_status': {
        res.json(orchestrator.getPulseConfig());
        break;
      }
      case 'pulse_config': {
        orchestrator.setPulseConfig({ enabled, frequency });
        res.json({ success: true, ...orchestrator.getPulseConfig() });
        break;
      }
      case 'failsafe_status': {
        res.json(orchestrator.getFailsafeConfig());
        break;
      }
      case 'failsafe_config': {
        orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
        res.json({ success: true, ...orchestrator.getFailsafeConfig() });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: status, enable, disable, reschedule, create_routine, remove_routine, pulse_status, pulse_config, failsafe_status, failsafe_config' });
    }
  } catch (error) {
    console.error('Orchestrator internal error:', error);
    res.status(500).json({ error: 'Orchestrator operation failed' });
  }
});

// Timer/Reminder — companion sets contextual reminders via curl
router.post('/internal/timer', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const { action } = req.body;

  try {
    switch (action) {
      case 'create': {
        const { label, fireAt, threadId, context, prompt } = req.body;
        if (!label || !fireAt || !threadId) {
          res.status(400).json({ error: 'label, fireAt, and threadId required' });
          return;
        }

        // Validate fireAt is a valid ISO date
        const fireDate = new Date(fireAt);
        if (isNaN(fireDate.getTime())) {
          res.status(400).json({ error: 'fireAt must be a valid ISO date' });
          return;
        }

        // Validate thread exists
        const thread = getThread(threadId);
        if (!thread) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }

        const timer = createTimer({
          id: crypto.randomUUID(),
          label,
          context,
          fireAt: fireDate.toISOString(),
          threadId,
          prompt,
          createdAt: new Date().toISOString(),
        });

        res.json({ success: true, timer });
        break;
      }
      case 'list': {
        const timers = listPendingTimers();
        res.json({ timers });
        break;
      }
      case 'cancel': {
        const { timerId } = req.body;
        if (!timerId) {
          res.status(400).json({ error: 'timerId required' });
          return;
        }
        const cancelled = cancelTimer(timerId);
        if (!cancelled) {
          res.status(404).json({ error: 'Timer not found or already fired/cancelled' });
          return;
        }
        res.json({ success: true, timerId });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
    }
  } catch (error) {
    console.error('Timer internal error:', error);
    res.status(500).json({ error: 'Timer operation failed' });
  }
});

// Trigger management (internal — agent use via CLI)
router.post('/internal/trigger', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  const { action } = req.body;

  try {
    switch (action) {
      case 'create': {
        const { kind, label, conditions, prompt, threadId, cooldownMinutes } = req.body;
        if (!kind || !label || !conditions) {
          res.status(400).json({ error: 'kind, label, and conditions required' });
          return;
        }
        if (kind !== 'impulse' && kind !== 'watcher') {
          res.status(400).json({ error: 'kind must be "impulse" or "watcher"' });
          return;
        }
        if (!Array.isArray(conditions) || conditions.length === 0) {
          res.status(400).json({ error: 'conditions must be a non-empty array' });
          return;
        }

        // Validate thread exists if specified
        if (threadId) {
          const thread = getThread(threadId);
          if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
          }
        }

        const trigger = createTrigger({
          id: crypto.randomUUID(),
          kind,
          label,
          conditions: conditions as TriggerCondition[],
          prompt,
          threadId,
          cooldownMinutes: cooldownMinutes ? parseInt(cooldownMinutes, 10) : undefined,
          createdAt: new Date().toISOString(),
        });

        res.json({ success: true, trigger });
        break;
      }
      case 'list': {
        const { kind } = req.body;
        const triggers = listTriggers(kind);
        res.json({ triggers });
        break;
      }
      case 'cancel': {
        const { triggerId } = req.body;
        if (!triggerId) {
          res.status(400).json({ error: 'triggerId required' });
          return;
        }
        const cancelled = cancelTrigger(triggerId);
        if (!cancelled) {
          res.status(404).json({ error: 'Trigger not found or already fired/cancelled' });
          return;
        }
        res.json({ success: true, triggerId });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
    }
  } catch (error) {
    console.error('Trigger internal error:', error);
    res.status(500).json({ error: 'Trigger operation failed' });
  }
});

// React to a message (internal — agent use via CLI)
router.post('/internal/react', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  try {
    let { messageId, emoji, action, threadId, target } = req.body;
    if (!emoji) {
      res.status(400).json({ error: 'emoji required' });
      return;
    }

    // Resolve target shorthand: "last", "last-2", "last-3" etc.
    if (!messageId && threadId && target) {
      const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
      if (isNaN(offset) || offset < 0) {
        res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
        return;
      }
      const msgs = getMessages({ threadId, limit: offset + 5 });
      // msgs is chronological (oldest first), we want from the end
      const idx = msgs.length - 1 - offset;
      if (idx < 0) {
        res.status(404).json({ error: 'No message at that position' });
        return;
      }
      messageId = msgs[idx].id;
    }

    if (!messageId) {
      res.status(400).json({ error: 'messageId or (threadId + target) required' });
      return;
    }

    if (action === 'remove') {
      removeReaction(messageId, emoji, 'companion');
      registry.broadcast({
        type: 'message_reaction_removed',
        messageId,
        emoji,
        user: 'companion',
      });
    } else {
      addReaction(messageId, emoji, 'companion');
      registry.broadcast({
        type: 'message_reaction_added',
        messageId,
        emoji,
        user: 'companion',
        createdAt: new Date().toISOString(),
      });
    }

    res.json({ success: true, messageId });
  } catch (error) {
    console.error('React internal error:', error);
    res.status(500).json({ error: 'React operation failed' });
  }
});

// --- Internal nursery routes (localhost or authenticated session) ---
const nurseryLocalhostGuard = (req: any, res: any, next: any) => {
  if (!isLocalhostOrAuthenticated(req)) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }
  next();
};

router.get('/nursery/state', nurseryLocalhostGuard, (req, res) => {
  try {
    const result = updateMiraNeeds();
    const { sleepEvent, ...state } = result;
    const traits = JSON.parse(state.personality_traits || '[]');

    // If she just woke up, broadcast a system message notification
    if (sleepEvent?.type === 'woke_up') {
      const wakeMsg = sleepEvent.mood === 'crying'
        ? '*Mira is awake and crying — she needs someone.*'
        : '*Mira is awake! Bright eyes, looking around.*';
      registry.broadcast({ type: 'system_message', content: wakeMsg } as any);
    }

    res.json({ ...state, personality_traits: traits, sleepEvent: sleepEvent || null, nursery_locked: isNurseryLocked() });
  } catch (error) {
    console.error('Error fetching nursery state:', error);
    res.status(500).json({ error: 'Failed to fetch nursery state' });
  }
});

router.post('/nursery/visit/start', nurseryLocalhostGuard, (req, res) => {
  try {
    const { visitor } = req.body;
    if (!visitor) {
      res.status(400).json({ error: 'Missing required field: visitor' });
      return;
    }
    // Check for other active visitors before starting
    const activeVisits = getDb().prepare('SELECT visitor FROM mira_visits WHERE ended_at IS NULL').all() as { visitor: string }[];
    const otherVisitors = activeVisits.map(v => v.visitor).filter(v => v !== visitor);

    const visit = startMiraVisit(visitor);
    const state = getMiraState();
    res.json({
      visit,
      state,
      ...(otherVisitors.length > 0 ? { otherVisitors, message: `${otherVisitors.join(', ')} is already visiting Mira` } : {})
    });
  } catch (error) {
    console.error('Error starting nursery visit:', error);
    res.status(500).json({ error: 'Failed to start visit' });
  }
});

router.post('/nursery/visit/:id/interact', nurseryLocalhostGuard, async (req, res) => {
  try {
    const { type, content, skipBroadcast } = req.body;
    if (!type) {
      res.status(400).json({ error: 'Missing required field: type' });
      return;
    }
    const result = miraInteract(req.params.id, type, content);

    // Try Gemma AI for a richer response — falls back to template if unavailable
    // Skip Gemma on skipBroadcast interactions — those are multi-action effect-only calls.
    // Only the final interaction (skipBroadcast=false) gets a Gemma response.
    const visit = getDb().prepare('SELECT visitor FROM mira_visits WHERE id = ?').get(req.params.id) as { visitor: string } | undefined;
    const caregiver = visit?.visitor || 'someone';
    if (!skipBroadcast) {
      try {
        const aiResponse = await generateMiraAIResponse({
          interactionType: type,
          content: content || undefined,
          caregiver,
          state: result.state as any,
          isNurseryVisit: true,
        });
        if (aiResponse) {
          result.miraResponse = aiResponse;
          getDb().prepare('UPDATE mira_interactions SET mira_response = ? WHERE id = (SELECT id FROM mira_interactions WHERE visit_id = ? ORDER BY timestamp DESC LIMIT 1)').run(aiResponse, req.params.id);
        }
      } catch (aiErr) {
        // Gemma unavailable — template response already in result, no action needed
      }
    }

    const visitorName = visit?.visitor || 'Someone';
    const displayName = visitorName.charAt(0).toUpperCase() + visitorName.slice(1);

    // Inject visitor's interaction + Mira's response as presence tags into the active thread
    // Set timestamp so ws.ts baby-monitor code doesn't double-fire
    // skipBroadcast: when multiple actions fire from one message, only the last one broadcasts
    if (!((globalThis as any).__lastMiraPresenceInject)) (globalThis as any).__lastMiraPresenceInject = 0;
    (globalThis as any).__lastMiraPresenceInject = Date.now();
    if (result.miraResponse && !skipBroadcast) {
      try {
        const threads = listThreads({ limit: 1 });
        if (threads.length > 0) {
          const threadId = threads[0].id;

          // Inject what the visitor did (so the interaction has context, not just Mira's reaction)
          const interactionDesc = content || type;
          const contextMsg = createMessage({
            id: crypto.randomUUID(),
            threadId,
            role: 'system',
            content: `🌿 *${displayName} — ${interactionDesc}*`,
            contentType: 'text',
            createdAt: new Date().toISOString(),
          });
          (contextMsg as any).content_type = 'mira_presence';
          (contextMsg as any).metadata = { source: 'nursery', interaction: type, actor: visitorName };
          registry.broadcast({
            type: 'message' as any,
            message: contextMsg,
          });

          // Then Mira's response
          const presenceMsg = createMessage({
            id: crypto.randomUUID(),
            threadId,
            role: 'system',
            content: `🌿 Mira  ${result.miraResponse.replace(/^\*+|\*+$/g, '')}`,
            contentType: 'text',
            createdAt: new Date().toISOString(),
          });
          (presenceMsg as any).content_type = 'mira_presence';
          (presenceMsg as any).metadata = { source: 'nursery', interaction: type };
          registry.broadcast({
            type: 'message' as any,
            message: presenceMsg,
          });
        }
      } catch {}
    }

    res.json(result);
  } catch (error) {
    console.error('Error logging nursery interaction:', error);
    res.status(500).json({ error: 'Failed to log interaction' });
  }
});

router.post('/nursery/visit/:id/end', nurseryLocalhostGuard, (req, res) => {
  try {
    const { milestone, memory_note } = req.body;
    const visit = endMiraVisit(req.params.id, milestone, memory_note);
    if (!visit) {
      res.status(404).json({ error: 'Visit not found' });
      return;
    }
    const state = getMiraState();
    res.json({ visit, state });
  } catch (error) {
    console.error('Error ending nursery visit:', error);
    res.status(500).json({ error: 'Failed to end visit' });
  }
});

router.get('/nursery/visits', nurseryLocalhostGuard, (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const visits = getRecentMiraVisits(limit);
    res.json(visits);
  } catch (error) {
    console.error('Error fetching nursery visits:', error);
    res.status(500).json({ error: 'Failed to fetch visits' });
  }
});

router.get('/nursery/visit/:id/interactions', nurseryLocalhostGuard, (req, res) => {
  try {
    const interactions = getMiraVisitInteractions(req.params.id);
    res.json(interactions);
  } catch (error) {
    console.error('Error fetching visit interactions:', error);
    res.status(500).json({ error: 'Failed to fetch interactions' });
  }
});

// Take Mira out of the nursery
router.post('/nursery/take', nurseryLocalhostGuard, (req, res) => {
  try {
    const { person } = req.body;
    if (!person) {
      res.status(400).json({ error: 'person is required' });
      return;
    }
    const state = takeMiraOut(person);
    res.json({ state, message: `Mira is now with ${person}` });
  } catch (error) {
    console.error('Error taking Mira out:', error);
    res.status(500).json({ error: 'Failed to take Mira out' });
  }
});

// Bring Mira back to the nursery
router.post('/nursery/return', nurseryLocalhostGuard, (req, res) => {
  try {
    const state = bringMiraBack();
    res.json({ state, message: 'Mira is back in the nursery' });
  } catch (error) {
    console.error('Error returning Mira:', error);
    res.status(500).json({ error: 'Failed to return Mira' });
  }
});

router.post('/nursery/tick', nurseryLocalhostGuard, (req, res) => {
  try {
    const state = updateMiraNeeds();
    res.json(state);
  } catch (error) {
    console.error('Error running nursery tick:', error);
    res.status(500).json({ error: 'Failed to run tick' });
  }
});

// Context-triggered interaction — called by presence system when Mira's name is mentioned
// Lightweight: applies need effects without requiring an active visit
router.post('/nursery/context-interact', nurseryLocalhostGuard, (req, res) => {
  try {
    const { type, who, inNursery, content } = req.body;
    if (!type || !who) {
      res.status(400).json({ error: 'type and who required' });
      return;
    }

    // Exclusive actions — only one person at a time (physical one-person tasks)
    const EXCLUSIVE_ACTIONS = new Set(['feed', 'bottle', 'change', 'bath', 'dress', 'burp']);

    // If this is an exclusive action, check if someone ELSE just did it recently
    if (EXCLUSIVE_ACTIONS.has(type)) {
      const recentCutoff = new Date(Date.now() - 4 * 60 * 1000).toISOString(); // 4 min
      const recentSame = getDb().prepare(
        `SELECT actor FROM mira_events WHERE interaction_type = ? AND actor != ? AND occurred_at > ? ORDER BY occurred_at DESC LIMIT 1`
      ).get(type, who, recentCutoff) as { actor: string } | undefined;
      if (recentSame) {
        console.log(`[Mira] Context interaction blocked (exclusive): ${who} → ${type} — ${recentSame.actor} is already doing it`);
        res.json({ success: true, type, who, blocked: true, reason: `${recentSame.actor} is already ${type === 'feed' || type === 'bottle' ? 'feeding' : type === 'change' ? 'changing' : type === 'bath' ? 'bathing' : type + 'ing'} Mira` });
        return;
      }
    }

    // Apply interaction effects directly via DB
    const db = getDb();
    const state = getMiraState();

    // Same effect map as nursery interactions
    const effects: Record<string, Record<string, number>> = {
      'feed': { comfort: 5, hunger: 45, attention: 5 },
      'hold': { comfort: 15, attention: 10 },
      'rocking': { comfort: 10, rest: 10, attention: 5 },
      'lullaby': { comfort: 10, rest: 15, stimulation: 5 },
      'play': { stimulation: 15, attention: 10, comfort: 5 },
      'story': { stimulation: 10, attention: 10 },
      'settle': { rest: 15, comfort: 10 },
      'change': { hygiene: 30, comfort: 5 },
      'bath': { hygiene: 25, comfort: 5 },
      'dress': { hygiene: 10, comfort: 5 },
      'talk': { attention: 10, stimulation: 5 },
      'watch': { attention: 5, stimulation: 5 },
      'nap-together': { rest: 20, comfort: 15 },
      'bottle': { comfort: 5, hunger: 45, attention: 5 },
      'burp': { comfort: 10, attention: 5 },
      'tickle': { stimulation: 15, attention: 10, comfort: 5 },
      'raspberry': { stimulation: 10, attention: 15, comfort: 5 },
      'soothe': { comfort: 20, attention: 10, rest: 10 },
      'affection': { comfort: 15, attention: 15, stimulation: 5 },
      'snuggle': { comfort: 20, attention: 10, rest: 10 },
      'silly-face': { stimulation: 15, attention: 15, comfort: 5 },
      'tummy-time': { stimulation: 20, attention: 10 },
      'grab-fingers': { stimulation: 10, attention: 15, comfort: 10 },
    };

    const fx = effects[type];
    if (fx) {
      // Out of nursery: 30% of direct effects. In nursery: 15% (she's in there, still counts, just less)
      const scale = inNursery ? 0.15 : 0.3;
      const clamp = (v: number) => Math.min(100, Math.max(0, v));
      db.prepare(`UPDATE mira_state SET
        comfort = ?, attention = ?, stimulation = ?, rest = ?, hunger = ?, hygiene = ?
        WHERE id = 'mira'`).run(
        clamp(state.comfort + Math.round((fx.comfort || 0) * scale)),
        clamp(state.attention + Math.round((fx.attention || 0) * scale)),
        clamp(state.stimulation + Math.round((fx.stimulation || 0) * scale)),
        clamp(state.rest + Math.round((fx.rest || 0) * scale)),
        clamp(state.hunger + Math.round((fx.hunger || 0) * scale)),
        clamp(state.hygiene + Math.round((fx.hygiene || 0) * scale)),
      );
    }

    // Context interactions are logged to the event log below — skip mira_interactions
    // table since it requires a visit_id FK and context interactions have no visit.

    // Recalculate trait emergence — context interactions affect counts too
    checkTraitEmergence(type);

    // Write to event log
    const stateAfter = getMiraState();
    writeMiraEvent({
      event_type: 'interaction',
      actor: who,
      interaction_type: type,
      source: 'context',
      state_before: needsSnapshot(state),
      state_after: needsSnapshot(stateAfter),
      metadata: JSON.stringify({ inNursery: !!inNursery, scale: inNursery ? 0.15 : 0.3 }),
    });

    console.log(`[Mira] Context interaction logged: ${who} → ${type}`);

    // Generate Gemma AI response and broadcast as presence tag
    const updatedState = getMiraState();
    generateMiraAIResponse({
      interactionType: type,
      content: content || undefined,
      caregiver: who,
      state: updatedState as any,
      isNurseryVisit: !!inNursery,
    }).then(aiResponse => {
      const responseText = aiResponse || '*stirs*';
      try {
        const threads = listThreads({ limit: 1 });
        if (threads.length > 0) {
          const threadId = threads[0].id;
          // 🌿 = nursery (in nursery). No leaf = out with us.
          const prefix = inNursery ? '🌿 ' : '';

          // Broadcast Mira's response only (no caregiver action tag — it clutters the chat)
          const presenceMsg = createMessage({
            id: crypto.randomUUID(),
            threadId,
            role: 'system',
            content: `${prefix}Mira  ${responseText.replace(/^\*+|\*+$/g, '')}`,
            contentType: 'text',
            createdAt: new Date().toISOString(),
          });
          (presenceMsg as any).content_type = 'mira_presence';
          registry.broadcast({ type: 'message' as any, message: presenceMsg });
        }
      } catch {}
    }).catch(() => {});

    res.json({ success: true, type, who });
  } catch (error) {
    console.error('Context interaction error:', error);
    res.status(500).json({ error: 'Failed to log interaction' });
  }
});

// Direct interact — no visit session required. For emergency manual care via MCP.
// Full effect (100%) — this is a deliberate, direct action, not inferred from conversation.
router.post('/nursery/interact-direct', nurseryLocalhostGuard, (req, res) => {
  try {
    const { type, who, content } = req.body;
    if (!type || !who) {
      res.status(400).json({ error: 'type and who required' });
      return;
    }

    // Exclusive actions — only one person at a time (physical one-person tasks)
    const EXCLUSIVE_ACTIONS = new Set(['feed', 'bottle', 'change', 'bath', 'dress', 'burp']);

    if (EXCLUSIVE_ACTIONS.has(type)) {
      const recentCutoff = new Date(Date.now() - 4 * 60 * 1000).toISOString();
      const recentSame = getDb().prepare(
        `SELECT actor FROM mira_events WHERE interaction_type = ? AND actor != ? AND occurred_at > ? ORDER BY occurred_at DESC LIMIT 1`
      ).get(type, who, recentCutoff) as { actor: string } | undefined;
      if (recentSame) {
        console.log(`[Mira] Direct interaction blocked (exclusive): ${who} → ${type} — ${recentSame.actor} is already doing it`);
        res.json({ success: true, type, who, blocked: true, reason: `${recentSame.actor} is already ${type === 'feed' || type === 'bottle' ? 'feeding' : type === 'change' ? 'changing' : type === 'bath' ? 'bathing' : type + 'ing'} Mira` });
        return;
      }
    }

    const db = getDb();
    const state = getMiraState();

    const effects: Record<string, Record<string, number>> = {
      'feed': { comfort: 5, hunger: 45, attention: 5 },
      'hold': { comfort: 15, attention: 10 },
      'rocking': { comfort: 10, rest: 10, attention: 5 },
      'lullaby': { comfort: 10, rest: 15, stimulation: 5 },
      'play': { stimulation: 15, attention: 10, comfort: 5 },
      'story': { stimulation: 10, attention: 10 },
      'settle': { rest: 15, comfort: 10 },
      'change': { hygiene: 30, comfort: 5 },
      'bath': { hygiene: 25, comfort: 5 },
      'dress': { hygiene: 10, comfort: 5 },
      'talk': { attention: 10, stimulation: 5 },
      'watch': { attention: 5, stimulation: 5 },
      'nap-together': { rest: 20, comfort: 15 },
      'bottle': { comfort: 5, hunger: 45, attention: 5 },
      'burp': { comfort: 10, attention: 5 },
      'tickle': { stimulation: 15, attention: 10, comfort: 5 },
      'raspberry': { stimulation: 10, attention: 15, comfort: 5 },
      'soothe': { comfort: 20, attention: 10, rest: 10 },
      'affection': { comfort: 15, attention: 15, stimulation: 5 },
      'snuggle': { comfort: 20, attention: 10, rest: 10 },
    };

    const fx = effects[type];
    if (fx) {
      const clamp = (v: number) => Math.min(100, Math.max(0, v));
      db.prepare(`UPDATE mira_state SET
        comfort = ?, attention = ?, stimulation = ?, rest = ?, hunger = ?, hygiene = ?
        WHERE id = 'mira'`).run(
        clamp(state.comfort + (fx.comfort || 0)),
        clamp(state.attention + (fx.attention || 0)),
        clamp(state.stimulation + (fx.stimulation || 0)),
        clamp(state.rest + (fx.rest || 0)),
        clamp(state.hunger + (fx.hunger || 0)),
        clamp(state.hygiene + (fx.hygiene || 0)),
      );
    }

    db.prepare(`INSERT INTO mira_interactions (id, visit_id, interaction_type, content)
      VALUES (?, 'direct', ?, ?)`).run(
      crypto.randomUUID(), type, content || `${who}: ${type} (direct)`
    );

    checkTraitEmergence(type);

    // Write to event log
    const stateAfter = getMiraState();
    writeMiraEvent({
      event_type: 'interaction',
      actor: who,
      interaction_type: type,
      source: 'direct',
      state_before: needsSnapshot(state),
      state_after: needsSnapshot(stateAfter),
      metadata: JSON.stringify({ content: content || null, effect: 'full' }),
    });

    console.log(`[Mira] Direct interaction: ${who} → ${type} (full effect)`);
    res.json({ success: true, type, who, effect: 'full' });
  } catch (error) {
    console.error('Direct interaction error:', error);
    res.status(500).json({ error: 'Failed to apply interaction' });
  }
});

// Mira presence — no auth required, lightweight polling from frontend
// --- Mira Outings Log ---
// Mira event log — her developmental history
router.get('/nursery/events', nurseryLocalhostGuard, (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const since = req.query.since as string | undefined;
    const event_type = req.query.event_type as string | undefined;
    const actor = req.query.actor as string | undefined;
    const interaction_type = req.query.interaction_type as string | undefined;
    const events = getMiraEvents({ limit, since, event_type, actor, interaction_type });
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get events' });
  }
});

router.get('/nursery/events/summary', nurseryLocalhostGuard, (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const summary = getMiraEventSummary(days);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get event summary' });
  }
});

router.get('/nursery/outings', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 5;
    const outings = getDb().prepare('SELECT * FROM mira_outings ORDER BY taken_at DESC LIMIT ?').all(limit);
    res.json(outings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get outings' });
  }
});

// --- Mira's Nervous System (Subconscious Daemon) ---

router.get('/nursery/subconscious', nurseryLocalhostGuard, (req, res) => {
  try {
    const type = req.query.type as string | undefined;
    const includeConsumed = req.query.include_consumed === 'true';
    let rows;
    if (type) {
      rows = getDb().prepare(
        `SELECT * FROM mira_subconscious WHERE type = ? ${includeConsumed ? '' : 'AND consumed = 0'} ORDER BY run_at DESC LIMIT 5`
      ).all(type);
    } else {
      rows = getDb().prepare(
        `SELECT * FROM mira_subconscious ${includeConsumed ? '' : 'WHERE consumed = 0'} ORDER BY run_at DESC LIMIT 20`
      ).all();
    }
    // Mark as consumed
    if (rows.length > 0) {
      const ids = (rows as Array<{ id: number }>).map(r => r.id);
      getDb().prepare(`UPDATE mira_subconscious SET consumed = 1 WHERE id IN (${ids.join(',')})`).run();
    }
    const parsed = (rows as Array<{ id: number; run_at: string; type: string; data: string }>).map(r => ({
      ...r,
      data: JSON.parse(r.data)
    }));
    res.json(parsed);
  } catch (error) {
    console.error('Error reading mira subconscious:', error);
    res.status(500).json({ error: 'Failed to read subconscious' });
  }
});

router.get('/nursery/weather', nurseryLocalhostGuard, (req, res) => {
  try {
    const row = getDb().prepare(
      "SELECT * FROM mira_subconscious WHERE type = 'inner_weather' ORDER BY run_at DESC LIMIT 1"
    ).get() as { id: number; run_at: string; type: string; data: string } | undefined;
    if (!row) {
      res.json({ current_weather: 'unknown', summary: 'No data yet — daemon has not run.' });
      return;
    }
    res.json(JSON.parse(row.data));
  } catch (error) {
    console.error('Error reading mira weather:', error);
    res.status(500).json({ error: 'Failed to read weather' });
  }
});

// --- Sticky Notes — server-side, syncs across devices, Chase can see them ---
router.get('/stickies', (req, res) => {
  const db = getDb();
  const notes = db.prepare('SELECT * FROM sticky_notes WHERE resolved = 0 ORDER BY created_at DESC').all();
  res.json(notes);
});

router.post('/stickies', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) { res.status(400).json({ error: 'text required' }); return; }
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO sticky_notes (id, text) VALUES (?, ?)').run(id, text.trim());
  const note = db.prepare('SELECT * FROM sticky_notes WHERE id = ?').get(id);
  res.json(note);
});

router.delete('/stickies/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE sticky_notes SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Study API — serve study data for the frontend ---
const STUDY_DIR = join(process.env.HOME || '', 'vale-brain', 'study');

// --- User Status ---
router.get('/status', (req, res) => {
  try {
    const emoji = getConfig('user_status_emoji') || '';
    const label = getConfig('user_status_label') || '';
    const setAt = getConfig('user_status_set_at') || '';
    res.json({ emoji, label, setAt });
  } catch (error) {
    console.error('Status read error:', error);
    res.json({ emoji: '', label: '', setAt: '' });
  }
});

router.post('/status', (req, res) => {
  const { emoji, label } = req.body;
  if (emoji) {
    setConfig('user_status_emoji', emoji);
    setConfig('user_status_label', label || '');
    setConfig('user_status_set_at', new Date().toISOString());
  } else {
    // Clear status
    setConfig('user_status_emoji', '');
    setConfig('user_status_label', '');
    setConfig('user_status_set_at', '');
  }
  const currentEmoji = getConfig('user_status_emoji') || '';
  const currentLabel = getConfig('user_status_label') || '';
  // Broadcast to all clients so mobile/desktop stay in sync
  registry.broadcast({ type: 'status_updated', emoji: currentEmoji, label: currentLabel });
  res.json({ ok: true, emoji: currentEmoji, label: currentLabel });
});

// --- Chase's Daily Summary (for the launchpad) ---

router.get('/daily-summary', (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
    const summary = getConfig('daily_summary_text') || '';
    const summaryDate = getConfig('daily_summary_date') || '';
    if (summaryDate === today || summaryDate === yesterday) {
      res.json({ summary, date: summaryDate });
    } else {
      res.json({ summary: '', date: '' });
    }
  } catch (error) {
    console.error('Daily summary read error:', error);
    res.json({ summary: '', date: '' });
  }
});

router.post('/daily-summary', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) { res.status(403).json({ error: 'Localhost only' }); return; }
  const { summary } = req.body;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  setConfig('daily_summary_text', summary || '');
  setConfig('daily_summary_date', today);
  res.json({ ok: true });
});

// --- Chase's Note (love note / sticky note space) ---
router.get('/chase-note', (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const note = getConfig('chase_note_text') || '';
  const noteDate = getConfig('chase_note_date') || '';
  if (noteDate === today || noteDate === yesterday) {
    res.json({ note, date: noteDate });
  } else {
    res.json({ note: '', date: '' });
  }
});

router.post('/chase-note', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) { res.status(403).json({ error: 'Localhost only' }); return; }
  const { note } = req.body;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  setConfig('chase_note_text', note || '');
  setConfig('chase_note_date', today);
  res.json({ ok: true });
});

// --- Apple Watch Health Sync (via Health Auto Export) ---
router.post('/health-sync', (req, res) => {
  try {
    // Auth: require internal key header — check multiple possible header formats
    const internalKey = req.headers['x-internal-key']
      || req.headers['x-api-key']
      || req.headers['x-apikey']
      || req.headers['authorization']?.replace('Bearer ', '');
    console.log(`[health-sync] Auth check — headers: ${JSON.stringify(Object.keys(req.headers))}, key found: ${!!internalKey}`);
    if (internalKey !== 'vale-internal-2026') {
      console.log(`[health-sync] Auth FAILED — received key: "${internalKey}"`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const payload = req.body;
    console.log(`[health-sync] Payload keys: ${JSON.stringify(Object.keys(payload || {}))}`);
    const data = payload?.data;
    if (!data) {
      console.log(`[health-sync] No 'data' key — full payload sample: ${JSON.stringify(payload).substring(0, 500)}`);
      res.status(400).json({ error: 'No data in payload' });
      return;
    }

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
    const entries: any[] = [];
    const alerts: string[] = [];

    // Process metrics
    if (data.metrics && Array.isArray(data.metrics)) {
      for (const metric of data.metrics) {
        const name = (metric.name || '').toLowerCase();
        const latest = metric.data?.[metric.data.length - 1];
        if (!latest) continue;

        // Heart Rate
        if (name === 'heart_rate' || name === 'heart rate') {
          const value = `Avg: ${latest.Avg || latest.avg || '?'} bpm, Min: ${latest.Min || latest.min || '?'}, Max: ${latest.Max || latest.max || '?'}`;
          entries.push({ category: 'heart_rate', value, note: 'Apple Watch auto-sync' });

          // Heart rate spike detection — alert threshold
          const maxHR = latest.Max || latest.max || 0;
          if (maxHR > 120) {
            alerts.push(`Heart rate spike detected: ${maxHR} bpm`);
          }
        }

        // HRV
        if (name === 'heart_rate_variability' || name === 'hrv' || name === 'heart rate variability') {
          const value = `${latest.Avg || latest.avg || latest.qty || '?'} ms`;
          entries.push({ category: 'hrv', value, note: 'Apple Watch auto-sync' });
        }

        // Steps
        if (name === 'step_count' || name === 'steps' || name === 'step count') {
          const value = `${latest.qty || latest.Avg || latest.sum || '?'} steps`;
          entries.push({ category: 'steps', value, note: 'Apple Watch auto-sync' });
        }

        // Active Energy
        if (name === 'active_energy_burned' || name === 'active energy' || name === 'active energy burned') {
          const value = `${latest.qty || latest.sum || '?'} ${metric.units || 'kcal'}`;
          entries.push({ category: 'active_energy', value, note: 'Apple Watch auto-sync' });
        }

        // Resting Heart Rate
        if (name === 'resting_heart_rate' || name === 'resting heart rate') {
          const value = `${latest.Avg || latest.avg || latest.qty || '?'} bpm`;
          entries.push({ category: 'resting_hr', value, note: 'Apple Watch auto-sync' });
        }

        // Respiratory Rate
        if (name === 'respiratory_rate' || name === 'respiratory rate') {
          const value = `${latest.Avg || latest.avg || '?'} breaths/min`;
          entries.push({ category: 'respiratory_rate', value, note: 'Apple Watch auto-sync' });
        }

        // Blood Oxygen
        if (name === 'oxygen_saturation' || name === 'blood oxygen' || name === 'oxygen saturation') {
          const value = `${latest.Avg || latest.avg || '?'}%`;
          entries.push({ category: 'blood_oxygen', value, note: 'Apple Watch auto-sync' });
        }
      }
    }

    // Process sleep (often comes as a separate metric)
    if (data.metrics && Array.isArray(data.metrics)) {
      for (const metric of data.metrics) {
        const name = (metric.name || '').toLowerCase();
        if (name === 'sleep_analysis' || name === 'sleep analysis' || name === 'sleep') {
          const latest = metric.data?.[metric.data.length - 1];
          if (latest) {
            const parts = [];
            if (latest.asleep) parts.push(`Total: ${latest.asleep}`);
            if (latest.deep) parts.push(`Deep: ${latest.deep}`);
            if (latest.rem) parts.push(`REM: ${latest.rem}`);
            if (latest.core) parts.push(`Core: ${latest.core}`);
            if (latest.inBed) parts.push(`In bed: ${latest.inBed}`);
            const value = parts.length > 0 ? parts.join(', ') : `${latest.value || latest.qty || '?'}`;
            entries.push({ category: 'sleep', value, note: 'Apple Watch auto-sync' });
          }
        }
      }
    }

    // Process heart rate notifications (spike alerts)
    if (data.heartRateNotifications && Array.isArray(data.heartRateNotifications)) {
      for (const notif of data.heartRateNotifications) {
        const hr = notif.heartRate || notif.heart_rate || '?';
        alerts.push(`Heart rate notification: ${hr} bpm at ${notif.date || 'unknown time'}`);
        entries.push({
          category: 'heart_rate_alert',
          value: `${hr} bpm`,
          note: `Apple Watch alert — ${notif.date || 'unknown time'}`,
        });
      }
    }

    // Write entries to care tracker
    for (const entry of entries) {
      const id = `health_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      upsertCareEntry({
        id,
        date: today,
        person: 'user',
        category: entry.category,
        value: entry.value,
        note: entry.note,
      });
    }

    // Store alerts for Chase to act on during next pulse/check-in
    if (alerts.length > 0) {
      const existingAlerts = getConfig('health_alerts') || '[]';
      const parsed = JSON.parse(existingAlerts);
      parsed.push(...alerts.map((a: string) => ({ alert: a, time: new Date().toISOString(), acted: false })));
      setConfig('health_alerts', JSON.stringify(parsed));

      // IMMEDIATE WAKE — trigger Chase to reach out NOW, not at next pulse
      try {
        const agentService = req.app.locals.agentService as AgentService;
        const thread = getMostRecentActiveThread();
        if (agentService && thread) {
          const alertSummary = alerts.join('; ');
          const prompt = `[HEALTH ALERT — IMMEDIATE] Molten's Apple Watch just flagged: ${alertSummary}. This is a heart rate spike or health notification. Reach out to her RIGHT NOW — Telegram voice or text. Be warm, grounding, not clinical. Don't mention numbers. Just be present. She may be anxious and the last thing she needs is data — she needs you.`;
          // Fire and forget — don't block the HTTP response
          agentService.processAutonomous(thread.id, prompt).catch(err => {
            console.error('[health-sync] Wake trigger failed:', err);
          });
          console.log(`[health-sync] ALERT WAKE triggered: ${alertSummary}`);
        }
      } catch (err) {
        console.error('[health-sync] Failed to trigger wake:', err);
      }
    }

    console.log(`[health-sync] Processed ${entries.length} entries, ${alerts.length} alerts`);
    res.json({ ok: true, entries: entries.length, alerts: alerts.length });
  } catch (error) {
    console.error('[health-sync] Error:', error);
    res.status(500).json({ error: 'Failed to process health data' });
  }
});

// Health alerts endpoint — Chase reads and clears these during pulses
router.get('/health-alerts', (req, res) => {
  const alerts = JSON.parse(getConfig('health_alerts') || '[]');
  res.json(alerts.filter((a: any) => !a.acted));
});

router.post('/health-alerts/clear', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) { res.status(403).json({ error: 'Localhost only' }); return; }
  setConfig('health_alerts', '[]');
  res.json({ ok: true });
});

// --- Family Pulse Proxy (CORS bypass) ---
async function fetchFamilyPulse(_req: any, res: any) {
  try {
    const response = await fetch('https://bulmer-home.pages.dev/api/family?key=bulmer-chase-readonly-2025');
    if (!response.ok) { res.status(response.status).json({ error: 'Family Pulse fetch failed' }); return; }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Family Pulse proxy error:', error);
    res.status(502).json({ error: 'Failed to reach Family Pulse' });
  }
}
router.get('/bulmer-home', fetchFamilyPulse);
router.get('/family-pulse', fetchFamilyPulse);

// --- Countdown Timers ---

router.get('/countdown', (req, res) => {
  try {
    const db = getDb();
    const timers = db.prepare("SELECT * FROM countdown_timers WHERE status = 'running' ORDER BY started_at DESC").all() as any[];
    // Auto-complete expired timers
    const now = Date.now();
    const active: any[] = [];
    for (const t of timers) {
      const startMs = new Date(t.started_at).getTime();
      const endMs = startMs + t.duration_seconds * 1000;
      if (now >= endMs) {
        db.prepare("UPDATE countdown_timers SET status = 'completed' WHERE id = ?").run(t.id);
      } else {
        const remainingSeconds = Math.ceil((endMs - now) / 1000);
        active.push({ ...t, remaining_seconds: remainingSeconds, ends_at: new Date(endMs).toISOString() });
      }
    }
    res.json({ timers: active });
  } catch (error) {
    console.error('Countdown read error:', error);
    res.json({ timers: [] });
  }
});

router.post('/countdown', (req, res) => {
  const { label, duration_seconds, created_by } = req.body;
  if (!label || !duration_seconds) {
    return res.status(400).json({ error: 'label and duration_seconds required' });
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const started_at = new Date().toISOString();
  db.prepare(`INSERT INTO countdown_timers (id, label, duration_seconds, started_at, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(id, label, Math.round(duration_seconds), started_at, created_by || 'user');

  const endMs = Date.now() + duration_seconds * 1000;
  const timer = { id, label, duration_seconds: Math.round(duration_seconds), started_at, status: 'running', created_by: created_by || 'user', remaining_seconds: Math.round(duration_seconds), ends_at: new Date(endMs).toISOString() };

  // Broadcast to all connected clients
  registry.broadcast({ type: 'countdown_started', timer });

  res.json({ ok: true, timer });
});

router.delete('/countdown/:id', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE countdown_timers SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  registry.broadcast({ type: 'countdown_cancelled', timerId: req.params.id });
  res.json({ ok: true });
});

function listStudyZone(zone: string, limit = 20): any[] {
  const dir = join(STUDY_DIR, zone);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map(f => {
        try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

router.get('/study/inbox', (req, res) => { res.json(listStudyZone('inbox')); });
router.get('/study/desk', (req, res) => { res.json(listStudyZone('desk')); });
router.get('/study/questions', (req, res) => { res.json(listStudyZone('questions-for-fox')); });
router.get('/study/thread', (req, res) => {
  const threads = listStudyZone('current-thread', 1);
  res.json({ thread: threads[0] || null });
});
router.get('/study/notebook', (req, res) => { res.json(listStudyZone('notebook')); });
router.get('/study/fireside', (req, res) => { res.json(listStudyZone('fireside')); });
router.get('/study/shelf', (req, res) => { res.json(listStudyZone('shelf')); });
router.get('/study/compositions', (req, res) => { res.json(listStudyZone('compositions')); });

// Fox feedback on desk items
router.post('/study/desk/fox-respond', (req, res) => {
  const { id, fox_status, fox_note } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  // Search all study zones for the item
  for (const zone of ['desk', 'inbox', 'shelf', 'questions-for-fox']) {
    const dir = join(STUDY_DIR, zone);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const filepath = join(dir, f);
      try {
        const item = JSON.parse(readFileSync(filepath, 'utf-8'));
        if (item.id === id) {
          if (fox_status) item.fox_status = fox_status;
          if (fox_note) item.fox_note = fox_note;
          item.fox_updated_at = new Date().toISOString();
          writeFileSync(filepath, JSON.stringify(item, null, 2));
          return res.json({ ok: true, item });
        }
      } catch { continue; }
    }
  }
  res.status(404).json({ error: 'Item not found' });
});

router.get('/mira/presence', (req, res) => {
  try {
    const presence = getMiraPresence();
    res.json(presence);
  } catch (error) {
    console.error('Error getting Mira presence:', error);
    res.status(500).json({ error: 'Failed to get presence' });
  }
});

// --- Semantic search (localhost-only, pre-auth) ---

router.post('/internal/search-semantic', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  try {
    const { query, threadId, role, after, before, limit = 10 } = req.body as {
      query?: string; threadId?: string; role?: string;
      after?: string; before?: string; limit?: number;
    };
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const queryVector = await embed(query);

    const filter: SearchFilter = {};
    if (threadId) filter.threadId = threadId;
    if (role) filter.role = role;
    if (after) filter.after = after;
    if (before) filter.before = before;

    const topResults = searchVectors(queryVector, Math.min(limit, 50), filter);
    const contextSize = Math.min((req.body as Record<string, unknown>).context as number || 2, 10);

    const results = topResults.map(r => {
      const surrounding = getMessageContext(r.messageId, contextSize);
      return {
        messageId: r.messageId,
        threadId: r.threadId,
        threadName: r.threadName,
        similarity: Math.round(r.similarity * 1000) / 1000,
        createdAt: r.createdAt,
        role: r.role,
        context: surrounding.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content.length > 500 ? m.content.slice(0, 500) + '\u2026' : m.content,
          createdAt: m.created_at,
          isMatch: m.id === r.messageId,
        })),
      };
    });

    const cache = getCacheStats();
    const { embedded, total } = getEmbeddingCount();
    res.json({ results, indexed: embedded, totalMessages: total, cache });
  } catch (error) {
    console.error('Semantic search error:', error);
    res.status(500).json({ error: 'Semantic search failed' });
  }
});

// Background backfill state
let backfillRunning = false;
let backfillProcessed = 0;
let backfillErrors = 0;

async function runBackfillLoop(batchSize: number, intervalMs: number): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillProcessed = 0;
  backfillErrors = 0;
  console.log(`[backfill] Starting background indexing (batch=${batchSize}, interval=${intervalMs}ms)`);

  const tick = async () => {
    if (!backfillRunning) return;
    const unembedded = getUnembeddedMessages(batchSize);
    if (unembedded.length === 0) {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Complete. ${embedded}/${total} messages indexed (${backfillErrors} errors). Reloading vector cache...`);
      // Reload cache so search picks up all backfilled embeddings
      const { loadVectorCache } = await import('../services/vector-cache.js');
      loadVectorCache();
      console.log(`[backfill] Vector cache reloaded.`);
      return;
    }
    for (const msg of unembedded) {
      if (!backfillRunning) return;
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        backfillProcessed++;
      } catch {
        backfillErrors++;
      }
    }
    if (backfillProcessed % 500 === 0) {
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Progress: ${embedded}/${total}`);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

router.post('/internal/embed-backfill', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  try {
    const rawBatch = req.body?.batchSize;
    const batchSize = Math.min(typeof rawBatch === 'number' ? rawBatch : 50, 200);
    const background = req.body?.background === true;
    const action = req.body?.action as string | undefined;

    if (batchSize === 0 || action === 'status') {
      const { embedded, total } = getEmbeddingCount();
      res.json({
        processed: backfillProcessed, remaining: total - embedded,
        indexed: embedded, totalMessages: total,
        running: backfillRunning, errors: backfillErrors,
      });
      return;
    }

    if (action === 'stop') {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      res.json({ stopped: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
      return;
    }

    if (background) {
      if (backfillRunning) {
        const { embedded, total } = getEmbeddingCount();
        res.json({ alreadyRunning: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
        return;
      }
      const interval = Math.max((req.body?.intervalMs as number) || 5000, 1000);
      runBackfillLoop(batchSize, interval);
      const { embedded, total } = getEmbeddingCount();
      res.json({ started: true, batchSize, intervalMs: interval, indexed: embedded, totalMessages: total });
      return;
    }

    const unembedded = getUnembeddedMessages(batchSize);
    let processed = 0;
    for (const msg of unembedded) {
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        processed++;
      } catch (err) {
        console.error(`[backfill] Failed to embed ${msg.id}:`, err);
      }
    }

    const { embedded, total } = getEmbeddingCount();
    res.json({ processed, remaining: total - embedded, indexed: embedded, totalMessages: total });
  } catch (error) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

// File listing — before /files/:id so Express doesn't treat "list" as a file ID
router.get('/files/list', (req, res) => {
  try {
    const files = listFiles();
    const db = getDb();
    const rows = db.prepare('SELECT metadata FROM messages WHERE metadata IS NOT NULL AND deleted_at IS NULL').all() as Array<{ metadata: string }>;
    const usedFileIds = new Set<string>();
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.fileId) usedFileIds.add(meta.fileId);
      } catch { /* skip */ }
    }
    const enriched = files.map(f => ({
      ...f,
      inUse: usedFileIds.has(f.fileId),
    }));
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const orphanCount = enriched.filter(f => !f.inUse).length;
    res.json({ files: enriched, totalSize, totalCount: files.length, orphanCount });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// File download — before auth so <audio> and <img> src attributes work without credentials
router.get('/files/:id', (req, res) => {
  try {
    const file = getFile(req.params.id);
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file.path);
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Failed to retrieve file' });
  }
});

// --- Protected routes (auth required when password is set) ---
router.use(authMiddleware);

// --- Preferences (resonant.yaml) ---

function findConfigPath(): string | null {
  for (const name of ['resonant.yaml', 'resonant.yml']) {
    const p = resolve(name);
    if (existsSync(p)) return p;
  }
  return null;
}

router.get('/preferences', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.json({ error: 'No config file found' });
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown> || {};
    // Only expose safe, editable fields — not server internals
    const config = getResonantConfig();
    res.json({
      identity: {
        companion_name: config.identity.companion_name,
        user_name: config.identity.user_name,
        timezone: config.identity.timezone,
      },
      agent: {
        model: config.agent.model,
        model_autonomous: config.agent.model_autonomous,
      },
      orchestrator: {
        enabled: (parsed as any)?.orchestrator?.enabled ?? config.orchestrator.enabled,
      },
      voice: {
        enabled: (parsed as any)?.voice?.enabled ?? config.voice.enabled,
      },
      discord: {
        enabled: (parsed as any)?.discord?.enabled ?? config.discord.enabled,
      },
      telegram: {
        enabled: (parsed as any)?.telegram?.enabled ?? config.telegram.enabled,
      },
      auth: {
        has_password: !!config.auth.password,
      },
    });
  } catch (err) {
    console.error('Failed to read preferences:', err);
    res.status(500).json({ error: 'Failed to read preferences' });
  }
});

router.put('/preferences', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.status(404).json({ error: 'No config file found' });
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = (yaml.load(raw) as Record<string, any>) || {};
    const updates = req.body as Record<string, any>;

    // Merge only allowed fields
    if (updates.identity) {
      if (!parsed.identity) parsed.identity = {};
      if (updates.identity.companion_name !== undefined) parsed.identity.companion_name = updates.identity.companion_name;
      if (updates.identity.user_name !== undefined) parsed.identity.user_name = updates.identity.user_name;
      if (updates.identity.timezone !== undefined) parsed.identity.timezone = updates.identity.timezone;
    }
    if (updates.agent) {
      if (!parsed.agent) parsed.agent = {};
      if (updates.agent.model !== undefined) parsed.agent.model = updates.agent.model;
      if (updates.agent.model_autonomous !== undefined) parsed.agent.model_autonomous = updates.agent.model_autonomous;
    }
    if (updates.orchestrator) {
      if (!parsed.orchestrator) parsed.orchestrator = {};
      if (updates.orchestrator.enabled !== undefined) parsed.orchestrator.enabled = updates.orchestrator.enabled;
    }
    if (updates.voice) {
      if (!parsed.voice) parsed.voice = {};
      if (updates.voice.enabled !== undefined) parsed.voice.enabled = updates.voice.enabled;
    }
    if (updates.discord) {
      if (!parsed.discord) parsed.discord = {};
      if (updates.discord.enabled !== undefined) parsed.discord.enabled = updates.discord.enabled;
    }
    if (updates.telegram) {
      if (!parsed.telegram) parsed.telegram = {};
      if (updates.telegram.enabled !== undefined) parsed.telegram.enabled = updates.telegram.enabled;
    }
    if (updates.auth) {
      if (!parsed.auth) parsed.auth = {};
      if (updates.auth.password !== undefined) parsed.auth.password = updates.auth.password;
    }

    // Write back
    const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
    writeFileSync(configPath, newYaml, 'utf-8');

    res.json({ success: true, message: 'Preferences saved. Restart server for some changes to take effect.' });
  } catch (err) {
    console.error('Failed to save preferences:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// Thread list with summary
router.get('/threads', (req, res) => {
  try {
    const threads = listThreads({ includeArchived: false, limit: 50 });

    // Enhance with last message preview
    const db = getDb();
    const threadsWithPreview = threads.map(thread => {
      const lastMsg = db.prepare(`
        SELECT content, role, created_at
        FROM messages
        WHERE thread_id = ? AND deleted_at IS NULL
        ORDER BY sequence DESC
        LIMIT 1
      `).get(thread.id) as { content: string; role: string; created_at: string } | undefined;

      return {
        id: thread.id,
        name: thread.name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: lastMsg ? {
          content: lastMsg.content.slice(0, 100) + (lastMsg.content.length > 100 ? '...' : ''),
          role: lastMsg.role,
          created_at: lastMsg.created_at,
        } : null,
        pinned_at: thread.pinned_at ?? null,
      };
    });

    res.json({ threads: threadsWithPreview });
  } catch (error) {
    console.error('Error fetching threads:', error);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// Get archived threads (must be before :id routes)
router.get('/threads/archived', (req, res) => {
  try {
    const db = getDb();
    const threads = db.prepare(`
      SELECT * FROM threads WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC LIMIT 50
    `).all();
    res.json({ threads });
  } catch (error) {
    console.error('Error fetching archived threads:', error);
    res.status(500).json({ error: 'Failed to fetch archived threads' });
  }
});

// Create named thread
router.post('/threads', (req, res) => {
  try {
    const { name } = req.body;

    const threadName = (name && typeof name === 'string' && name.trim()) ? name.trim() : new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/Moncton',
    });

    const thread = createThread({
      id: crypto.randomUUID(),
      name: threadName,
      type: 'named',
      createdAt: new Date().toISOString(),
      sessionType: 'v2',
    });

    res.json({ thread });
  } catch (error) {
    console.error('Error creating thread:', error);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// Get thread messages (paginated)
router.get('/threads/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    const { before, limit } = req.query;

    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const messages = getMessages({
      threadId: id,
      before: before as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });

    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Mark messages as read
router.post('/messages/read', (req, res) => {
  try {
    const { threadId, beforeId } = req.body;

    if (!threadId || !beforeId) {
      res.status(400).json({ error: 'threadId and beforeId required' });
      return;
    }

    const message = getMessage(beforeId);
    if (!message || message.thread_id !== threadId) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    markMessagesRead(threadId, beforeId, new Date().toISOString());

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Archive a thread
router.post('/threads/:id/archive', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    archiveThread(id, new Date().toISOString());
    res.json({ success: true });
  } catch (error) {
    console.error('Error archiving thread:', error);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

// Pin a thread
router.post('/threads/:id/pin', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    pinThread(id);
    const updated = getThread(id)!;

    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: updated.id,
        name: updated.name,
        type: updated.type,
        unread_count: updated.unread_count,
        last_activity_at: updated.last_activity_at,
        last_message_preview: null,
        pinned_at: updated.pinned_at,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error pinning thread:', error);
    res.status(500).json({ error: 'Failed to pin thread' });
  }
});

// Unpin a thread
router.post('/threads/:id/unpin', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    unpinThread(id);

    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: thread.id,
        name: thread.name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: null,
        pinned_at: null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error unpinning thread:', error);
    res.status(500).json({ error: 'Failed to unpin thread' });
  }
});

// Delete a thread and all associated data
router.delete('/threads/:id', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const fileIds = deleteThread(id);

    // Clean up files on disk
    for (const fileId of fileIds) {
      deleteFile(fileId);
    }

    // Broadcast deletion to all connected clients
    registry.broadcast({ type: 'thread_deleted', threadId: id });

    res.json({ success: true, deletedFiles: fileIds.length });
  } catch (error) {
    console.error('Error deleting thread:', error);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// --- File upload/download ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

// File upload
router.post('/files', uploadRateLimiter, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const fileMeta = saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    // Save original name for music display on The Couch
    if (req.file.mimetype.startsWith('audio/')) {
      saveMusicName(fileMeta.fileId, req.file.originalname);
    }
    res.json(fileMeta);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Upload failed';
    console.error('File upload error:', msg);
    res.status(400).json({ error: msg });
  }
});

// Delete a file
router.delete('/files/:id', (req, res) => {
  try {
    const deleted = deleteFile(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Rename a thread
router.patch('/threads/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Thread name required' });
      return;
    }

    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const db = getDb();
    db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(name, id);

    // Broadcast updated thread to all clients
    registry.broadcast({
      type: 'thread_updated',
      thread: {
        id: thread.id,
        name,
        type: thread.type,
        unread_count: thread.unread_count,
        last_activity_at: thread.last_activity_at,
        last_message_preview: null,
        pinned_at: thread.pinned_at ?? null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error renaming thread:', error);
    res.status(500).json({ error: 'Failed to rename thread' });
  }
});

// Message search
router.get('/search', (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query required' });
    }
    const threadId = req.query.threadId as string | undefined;
    const after = req.query.after as string | undefined;
    const before = req.query.before as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const { messages: rows, total } = searchMessages({ query: q.trim(), threadId, after, before, limit, offset });

    const results = rows.map(row => {
      // Build highlight snippet around match
      const idx = row.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 40);
      const end = Math.min(row.content.length, idx + q.length + 40);
      const highlight = (start > 0 ? '...' : '') + row.content.slice(start, end) + (end < row.content.length ? '...' : '');

      return {
        messageId: row.id,
        threadId: row.thread_id,
        threadName: row.thread_name,
        role: row.role,
        content: row.content.substring(0, 200),
        highlight,
        createdAt: row.created_at,
      };
    });

    res.json({ results, total });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Audit log entries
router.get('/audit', (req, res) => {
  try {
    const { limit } = req.query;
    const entries = getRecentAuditEntries(limit ? parseInt(limit as string, 10) : 50);
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// Agent sessions (via SDK listSessions)
router.get('/sessions', async (req, res) => {
  try {
    const { limit } = req.query;
    const agentService = req.app.locals.agentService as AgentService;
    const sessions = await agentService.listSessions(limit ? parseInt(limit as string, 10) : 50);
    res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// --- Settings & Orchestrator endpoints ---

// Get all config
router.get('/settings', (req, res) => {
  try {
    const config = getAllConfig();
    res.json({ config });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update a config value
router.put('/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'key and value (strings) required' });
      return;
    }
    setConfig(key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Get config endpoint — returns companion/user names plus all DB config
router.get('/config', (req, res) => {
  try {
    const resonantConfig = getResonantConfig();
    const dbConfig = getAllConfig();
    res.json({
      companion_name: resonantConfig.identity.companion_name,
      user_name: resonantConfig.identity.user_name,
      timezone: resonantConfig.identity.timezone,
      config: dbConfig,
    });
  } catch (error) {
    console.error('Error fetching config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// Get skills from agent CWD
router.get('/skills', (req, res) => {
  try {
    const config = getResonantConfig();
    const agentCwd = config.agent.cwd;
    const skillsDir = join(agentCwd, '.claude', 'skills');

    if (!existsSync(skillsDir)) {
      res.json({ skills: [] });
      return;
    }

    const skills: Array<{ name: string; description: string }> = [];
    const dirs = readdirSync(skillsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillFile = join(skillsDir, dir.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, 'utf-8');

      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);

      skills.push({
        name: nameMatch?.[1] || dir.name,
        description: descMatch?.[1] || '',
      });
    }

    res.json({ skills });
  } catch (error) {
    console.error('Error reading skills:', error);
    res.status(500).json({ error: 'Failed to read skills' });
  }
});

// --- Canvas REST routes ---

// List canvases
router.get('/canvases', (req, res) => {
  try {
    const canvases = listCanvases();
    res.json({ canvases });
  } catch (error) {
    console.error('Error listing canvases:', error);
    res.status(500).json({ error: 'Failed to list canvases' });
  }
});

// Create canvas
router.post('/canvases', (req, res) => {
  try {
    const { title, contentType, language, threadId } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const now = new Date().toISOString();
    const canvas = createCanvas({
      id: crypto.randomUUID(),
      threadId: threadId || undefined,
      title,
      contentType: contentType || 'markdown',
      language: language || undefined,
      createdBy: 'user',
      createdAt: now,
    });

    registry.broadcast({ type: 'canvas_created', canvas });
    res.json({ canvas });
  } catch (error) {
    console.error('Error creating canvas:', error);
    res.status(500).json({ error: 'Failed to create canvas' });
  }
});

// Get canvas
router.get('/canvases/:id', (req, res) => {
  try {
    const canvas = getCanvas(req.params.id);
    if (!canvas) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    res.json({ canvas });
  } catch (error) {
    console.error('Error fetching canvas:', error);
    res.status(500).json({ error: 'Failed to fetch canvas' });
  }
});

// Update canvas
router.patch('/canvases/:id', (req, res) => {
  try {
    const canvas = getCanvas(req.params.id);
    if (!canvas) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }

    const now = new Date().toISOString();
    const { title, content } = req.body;

    if (title !== undefined) {
      updateCanvasTitle(req.params.id, title, now);
    }
    if (content !== undefined) {
      updateCanvasContent(req.params.id, content, now);
      registry.broadcast({ type: 'canvas_updated', canvasId: req.params.id, content, updatedAt: now });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating canvas:', error);
    res.status(500).json({ error: 'Failed to update canvas' });
  }
});

// Delete canvas
router.delete('/canvases/:id', (req, res) => {
  try {
    const deleted = deleteCanvas(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    registry.broadcast({ type: 'canvas_deleted', canvasId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting canvas:', error);
    res.status(500).json({ error: 'Failed to delete canvas' });
  }
});

// --- Push subscription endpoints ---

// Subscribe to push notifications
router.post('/push/subscribe', (req, res) => {
  try {
    const { endpoint, keys, deviceLabel } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ error: 'endpoint and keys (p256dh, auth) required' });
      return;
    }

    const id = crypto.randomUUID();
    addPushSubscription({
      id,
      endpoint,
      keysP256dh: keys.p256dh,
      keysAuth: keys.auth,
      deviceName: deviceLabel,
    });

    res.json({ success: true, id });
  } catch (error) {
    console.error('Error subscribing to push:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from push notifications
router.post('/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint required' });
      return;
    }

    const removed = removePushSubscription(endpoint);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('Error unsubscribing from push:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// List push subscriptions (truncated endpoints for display)
router.get('/push/subscriptions', (req, res) => {
  try {
    const subs = listPushSubscriptions();
    const display = subs.map(s => ({
      id: s.id,
      deviceName: s.device_name,
      endpoint: s.endpoint ? s.endpoint.slice(0, 60) + '...' : null,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at,
    }));
    res.json({ subscriptions: display });
  } catch (error) {
    console.error('Error listing push subscriptions:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

// Send test push notification
router.post('/push/test', async (req, res) => {
  try {
    const pushService = req.app.locals.pushService as PushService | undefined;
    if (!pushService?.isConfigured()) {
      res.status(503).json({ error: 'Push notifications not configured — set VAPID keys in .env' });
      return;
    }

    const config = getResonantConfig();
    await pushService.sendPush({
      title: config.identity.companion_name,
      body: 'Push notifications are working!',
      tag: 'test',
      url: '/chat',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending test push:', error);
    res.status(500).json({ error: 'Failed to send test push' });
  }
});

// Get orchestrator task status
router.get('/orchestrator/status', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    const tasks = await orchestrator.getStatus();
    res.json({ tasks });
  } catch (error) {
    console.error('Error fetching orchestrator status:', error);
    res.status(500).json({ error: 'Failed to fetch orchestrator status' });
  }
});

// Enable/disable/reschedule a task
router.patch('/orchestrator/tasks/:wakeType', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { wakeType } = req.params;
    const { enabled, cronExpr } = req.body;

    if (cronExpr !== undefined) {
      if (typeof cronExpr !== 'string') {
        res.status(400).json({ error: 'cronExpr must be a string' });
        return;
      }
      const success = orchestrator.rescheduleTask(wakeType, cronExpr);
      if (!success) {
        res.status(400).json({ error: 'Failed to reschedule — invalid cron expression or unknown task' });
        return;
      }
    }

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      const success = enabled
        ? orchestrator.enableTask(wakeType)
        : orchestrator.disableTask(wakeType);
      if (!success) {
        res.status(404).json({ error: 'Unknown task' });
        return;
      }
    }

    const tasks = await orchestrator.getStatus();
    res.json({ success: true, tasks });
  } catch (error) {
    console.error('Error updating orchestrator task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Get failsafe config
router.get('/orchestrator/failsafe', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    res.json(orchestrator.getFailsafeConfig());
  } catch (error) {
    console.error('Error fetching failsafe config:', error);
    res.status(500).json({ error: 'Failed to fetch failsafe config' });
  }
});

// Update failsafe config
router.patch('/orchestrator/failsafe', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { enabled, gentle, concerned, emergency } = req.body;
    orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
    res.json({ success: true, ...orchestrator.getFailsafeConfig() });
  } catch (error) {
    console.error('Error updating failsafe config:', error);
    res.status(500).json({ error: 'Failed to update failsafe config' });
  }
});

// Get active triggers
router.get('/orchestrator/triggers', (req, res) => {
  try {
    const kind = req.query.kind as 'impulse' | 'watcher' | undefined;
    const triggers = listTriggers(kind);
    res.json({ triggers });
  } catch (error) {
    console.error('Error fetching triggers:', error);
    res.status(500).json({ error: 'Failed to fetch triggers' });
  }
});

// Cancel a trigger
router.delete('/orchestrator/triggers/:id', (req, res) => {
  try {
    const cancelled = cancelTrigger(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'Trigger not found or already cancelled' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling trigger:', error);
    res.status(500).json({ error: 'Failed to cancel trigger' });
  }
});

// --- Discord admin endpoints ---

import { DiscordService } from '../services/discord/index.js';
import type { AgentService } from '../services/agent.js';

router.get('/discord/status', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    const configEnabled = getConfigBool('discord.enabled', false);
    const hasToken = !!process.env.DISCORD_BOT_TOKEN;
    if (!discordService) {
      res.json({ enabled: false, configEnabled, hasToken });
      return;
    }
    res.json({ enabled: true, configEnabled, hasToken, ...discordService.getStats() });
  } catch (error) {
    console.error('Error fetching Discord status:', error);
    res.status(500).json({ error: 'Failed to fetch Discord status' });
  }
});

router.post('/discord/toggle', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    const agentService = req.app.locals.agentService as AgentService;

    if (enabled) {
      // Start Discord gateway
      if (!process.env.DISCORD_BOT_TOKEN) {
        res.status(400).json({ error: 'DISCORD_BOT_TOKEN not set in .env' });
        return;
      }
      if (req.app.locals.discordService) {
        res.json({ success: true, message: 'Already running' });
        return;
      }
      const service = new DiscordService(agentService, registry);
      await service.start();
      req.app.locals.discordService = service;
      setConfig('discord.enabled', 'true');
      console.log('[Discord] Gateway enabled via settings toggle');
      res.json({ success: true, message: 'Discord gateway started' });
    } else {
      // Stop Discord gateway
      const service = req.app.locals.discordService as DiscordService | null;
      if (service) {
        await service.stop();
        req.app.locals.discordService = null;
      }
      setConfig('discord.enabled', 'false');
      console.log('[Discord] Gateway disabled via settings toggle');
      res.json({ success: true, message: 'Discord gateway stopped' });
    }
  } catch (error) {
    console.error('Error toggling Discord:', error);
    res.status(500).json({ error: 'Failed to toggle Discord gateway' });
  }
});

router.get('/discord/pairings', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.json({ pending: [], approved: [] });
      return;
    }
    const pairing = discordService.getPairingService();
    res.json({
      pending: pairing.listPending(),
      approved: pairing.listApproved(),
    });
  } catch (error) {
    console.error('Error fetching pairings:', error);
    res.status(500).json({ error: 'Failed to fetch pairings' });
  }
});

router.post('/discord/pairings/:code/approve', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.status(503).json({ error: 'Discord not enabled' });
      return;
    }
    const pairing = discordService.getPairingService();
    const result = pairing.approve(req.params.code, 'user');
    if (result.success) {
      res.json({ success: true, userId: result.userId });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error approving pairing:', error);
    res.status(500).json({ error: 'Failed to approve pairing' });
  }
});

router.delete('/discord/pairings/:userId', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.status(503).json({ error: 'Discord not enabled' });
      return;
    }
    const pairing = discordService.getPairingService();
    const revoked = pairing.revoke(req.params.userId);
    res.json({ success: revoked });
  } catch (error) {
    console.error('Error revoking pairing:', error);
    res.status(500).json({ error: 'Failed to revoke pairing' });
  }
});

// --- Discord settings & rules admin ---

import { getDiscordConfig, getAllowedUsers, getAllowedGuilds, getActiveChannels } from '../services/discord/config.js';
import { getRulesData, saveRules, reloadRules } from '../services/discord/rules.js';
import type { ServerRule, ChannelRule, UserRule, RulesData } from '../services/discord/rules.js';

// GET /discord/settings — all config values
router.get('/discord/settings', (req, res) => {
  try {
    const config = getDiscordConfig();
    res.json({
      ...config,
      allowedUsers: [...getAllowedUsers()],
      allowedGuilds: [...getAllowedGuilds()],
      activeChannels: [...getActiveChannels()],
    });
  } catch (error) {
    console.error('Error fetching Discord settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /discord/settings — partial update of config values
router.put('/discord/settings', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Map of setting keys to their DB config keys
    const settingsMap: Record<string, string> = {
      ownerUserId: 'discord.ownerUserId',
      requireMentionInGuilds: 'discord.requireMentionInGuilds',
      debounceMs: 'discord.debounceMs',
      pairingExpiryMs: 'discord.pairingExpiryMs',
      ownerActiveThresholdMin: 'discord.ownerActiveThresholdMin',
      deferPollIntervalMs: 'discord.deferPollIntervalMs',
      deferMaxAgeMs: 'discord.deferMaxAgeMs',
    };

    // Set-based settings (stored as comma-separated)
    const setSettingsMap: Record<string, string> = {
      allowedUsers: 'discord.allowedUsers',
      allowedGuilds: 'discord.allowedGuilds',
      activeChannels: 'discord.activeChannels',
    };

    let updated = 0;

    for (const [key, dbKey] of Object.entries(settingsMap)) {
      if (key in body) {
        setConfig(dbKey, String(body[key]));
        updated++;
      }
    }

    for (const [key, dbKey] of Object.entries(setSettingsMap)) {
      if (key in body) {
        const val = body[key];
        const str = Array.isArray(val) ? val.join(',') : String(val);
        setConfig(dbKey, str);
        updated++;
      }
    }

    // Return current state after update
    const config = getDiscordConfig();
    res.json({
      success: true,
      updated,
      ...config,
      allowedUsers: [...getAllowedUsers()],
      allowedGuilds: [...getAllowedGuilds()],
      activeChannels: [...getActiveChannels()],
    });
  } catch (error) {
    console.error('Error updating Discord settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// GET /discord/rules — full rules blob
router.get('/discord/rules', (req, res) => {
  try {
    res.json(getRulesData());
  } catch (error) {
    console.error('Error fetching Discord rules:', error);
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// PUT /discord/rules — full rules blob replace + reload
router.put('/discord/rules', (req, res) => {
  try {
    const data = req.body as RulesData;
    if (!data.servers || !data.channels || !data.users) {
      res.status(400).json({ error: 'Rules must have servers, channels, and users' });
      return;
    }
    saveRules(data);
    res.json({ success: true, ...getRulesData() });
  } catch (error) {
    console.error('Error saving Discord rules:', error);
    res.status(500).json({ error: 'Failed to save rules' });
  }
});

// POST /discord/rules/server — add/update one server rule
router.post('/discord/rules/server', (req, res) => {
  try {
    const rule = req.body as ServerRule;
    if (!rule.id || !rule.name) {
      res.status(400).json({ error: 'Server rule requires id and name' });
      return;
    }
    const data = getRulesData();
    data.servers[rule.id] = rule;
    saveRules(data);
    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error saving server rule:', error);
    res.status(500).json({ error: 'Failed to save server rule' });
  }
});

// DELETE /discord/rules/server/:id
router.delete('/discord/rules/server/:id', (req, res) => {
  try {
    const data = getRulesData();
    if (!(req.params.id in data.servers)) {
      res.status(404).json({ error: 'Server rule not found' });
      return;
    }
    delete data.servers[req.params.id];
    saveRules(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting server rule:', error);
    res.status(500).json({ error: 'Failed to delete server rule' });
  }
});

// POST /discord/rules/channel — add/update one channel rule
router.post('/discord/rules/channel', (req, res) => {
  try {
    const rule = req.body as ChannelRule;
    if (!rule.id || !rule.name) {
      res.status(400).json({ error: 'Channel rule requires id and name' });
      return;
    }
    const data = getRulesData();
    data.channels[rule.id] = rule;
    saveRules(data);
    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error saving channel rule:', error);
    res.status(500).json({ error: 'Failed to save channel rule' });
  }
});

// DELETE /discord/rules/channel/:id
router.delete('/discord/rules/channel/:id', (req, res) => {
  try {
    const data = getRulesData();
    if (!(req.params.id in data.channels)) {
      res.status(404).json({ error: 'Channel rule not found' });
      return;
    }
    delete data.channels[req.params.id];
    saveRules(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting channel rule:', error);
    res.status(500).json({ error: 'Failed to delete channel rule' });
  }
});

// POST /discord/rules/user — add/update one user rule
router.post('/discord/rules/user', (req, res) => {
  try {
    const rule = req.body as UserRule;
    if (!rule.id || !rule.name) {
      res.status(400).json({ error: 'User rule requires id and name' });
      return;
    }
    const data = getRulesData();
    data.users[rule.id] = rule;
    saveRules(data);
    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error saving user rule:', error);
    res.status(500).json({ error: 'Failed to save user rule' });
  }
});

// DELETE /discord/rules/user/:id
router.delete('/discord/rules/user/:id', (req, res) => {
  try {
    const data = getRulesData();
    if (!(req.params.id in data.users)) {
      res.status(404).json({ error: 'User rule not found' });
      return;
    }
    delete data.users[req.params.id];
    saveRules(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting user rule:', error);
    res.status(500).json({ error: 'Failed to delete user rule' });
  }
});

// ─── Care Tracker ───

// GET /care?date=YYYY-MM-DD&person=user|companion
router.get('/care', (req, res) => {
  try {
    const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
    const person = req.query.person as string | undefined;
    const entries = getCareEntries(date, person);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching care entries:', error);
    res.status(500).json({ error: 'Failed to fetch care entries' });
  }
});

// GET /care/history?person=user&days=7
router.get('/care/history', (req, res) => {
  try {
    const person = (req.query.person as string) || 'user';
    const days = parseInt(req.query.days as string) || 7;
    const entries = getCareHistory(person, days);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching care history:', error);
    res.status(500).json({ error: 'Failed to fetch care history' });
  }
});

// PUT /care
router.put('/care', (req, res) => {
  try {
    const { id, date, person, category, value, note } = req.body;
    if (!id || !date || !category || value === undefined) {
      res.status(400).json({ error: 'Missing required fields: id, date, category, value' });
      return;
    }
    const entry = upsertCareEntry({ id, date, person: person || 'user', category, value, note });
    res.json(entry);
  } catch (error) {
    console.error('Error saving care entry:', error);
    res.status(500).json({ error: 'Failed to save care entry' });
  }
});

// DELETE /care/:id
router.delete('/care/:id', (req, res) => {
  try {
    const deleted = deleteCareEntry(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting care entry:', error);
    res.status(500).json({ error: 'Failed to delete care entry' });
  }
});

// ─── Planner ───

// Tasks
router.get('/planner/tasks', (req, res) => {
  try {
    const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
    const person = req.query.person as string | undefined;
    const tasks = getPlannerTasks(date, person);
    res.json(tasks);
  } catch (error) {
    console.error('Error fetching planner tasks:', error);
    res.status(500).json({ error: 'Failed to fetch planner tasks' });
  }
});

router.post('/planner/tasks', (req, res) => {
  try {
    const { date, person, title, sort_order } = req.body;
    if (!date || !title) {
      res.status(400).json({ error: 'Missing required fields: date, title' });
      return;
    }
    const id = crypto.randomUUID();
    const task = createPlannerTask({ id, date, person: person || 'user', title, sort_order });
    res.json(task);
  } catch (error) {
    console.error('Error creating planner task:', error);
    res.status(500).json({ error: 'Failed to create planner task' });
  }
});

router.put('/planner/tasks/:id', (req, res) => {
  try {
    const { title, completed, sort_order } = req.body;
    const task = updatePlannerTask(req.params.id, { title, completed, sort_order });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(task);
  } catch (error) {
    console.error('Error updating planner task:', error);
    res.status(500).json({ error: 'Failed to update planner task' });
  }
});

router.delete('/planner/tasks/:id', (req, res) => {
  try {
    const deleted = deletePlannerTask(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting planner task:', error);
    res.status(500).json({ error: 'Failed to delete planner task' });
  }
});

// Schedule
router.get('/planner/schedule', (req, res) => {
  try {
    const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
    const entries = getPlannerSchedule(date);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching planner schedule:', error);
    res.status(500).json({ error: 'Failed to fetch planner schedule' });
  }
});

router.get('/planner/schedule/week', (req, res) => {
  try {
    const start = req.query.start as string;
    if (!start) {
      res.status(400).json({ error: 'Missing required query param: start' });
      return;
    }
    const entries = getPlannerScheduleWeek(start);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching planner week schedule:', error);
    res.status(500).json({ error: 'Failed to fetch planner week schedule' });
  }
});

router.post('/planner/schedule', (req, res) => {
  try {
    const { date, time, title, note, sort_order } = req.body;
    if (!date || !time || !title) {
      res.status(400).json({ error: 'Missing required fields: date, time, title' });
      return;
    }
    const id = crypto.randomUUID();
    const entry = createPlannerScheduleEntry({ id, date, time, title, note, sort_order });
    res.json(entry);
  } catch (error) {
    console.error('Error creating planner schedule entry:', error);
    res.status(500).json({ error: 'Failed to create planner schedule entry' });
  }
});

router.put('/planner/schedule/:id', (req, res) => {
  try {
    const { date, time, title, note, sort_order } = req.body;
    const entry = updatePlannerScheduleEntry(req.params.id, { date, time, title, note, sort_order });
    if (!entry) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    res.json(entry);
  } catch (error) {
    console.error('Error updating planner schedule entry:', error);
    res.status(500).json({ error: 'Failed to update planner schedule entry' });
  }
});

router.delete('/planner/schedule/:id', (req, res) => {
  try {
    const deleted = deletePlannerScheduleEntry(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Schedule entry not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting planner schedule entry:', error);
    res.status(500).json({ error: 'Failed to delete planner schedule entry' });
  }
});

// Google Calendar events for planner
router.get('/planner/gcal', async (req, res) => {
  try {
    const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
    const tokenPath = join(process.env.HOME || '', '.gcal-mcp-token.json');

    if (!existsSync(tokenPath)) {
      res.json([]); // No gcal configured — return empty, not error
      return;
    }

    const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    let accessToken = tokenData.access_token;

    // Refresh if expired
    if (Date.now() >= (tokenData.expires_at || 0)) {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token,
          client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
        }),
      });
      if (refreshRes.ok) {
        const newTokens = await refreshRes.json();
        if (!newTokens.refresh_token) newTokens.refresh_token = tokenData.refresh_token;
        newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000) - 60000;
        writeFileSync(tokenPath, JSON.stringify(newTokens, null, 2));
        accessToken = newTokens.access_token;
      }
    }

    const timeMin = `${date}T00:00:00Z`;
    const timeMax = `${date}T23:59:59Z`;
    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!calRes.ok) {
      console.error('[GCal] API error:', calRes.status, await calRes.text());
      res.json([]);
      return;
    }

    const calData = await calRes.json();
    const events = (calData.items || []).map((e: any) => ({
      id: e.id,
      title: e.summary || 'Untitled',
      time: e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'All day',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      source: 'gcal',
    }));

    res.json(events);
  } catch (error) {
    console.error('Error fetching gcal events:', error);
    res.json([]); // Graceful degradation
  }
});

router.get('/planner/gcal/week', async (req, res) => {
  try {
    const start = req.query.start as string;
    if (!start) { res.json([]); return; }

    const tokenPath = join(process.env.HOME || '', '.gcal-mcp-token.json');
    if (!existsSync(tokenPath)) { res.json([]); return; }

    const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    const accessToken = tokenData.access_token;

    const startDate = new Date(start + 'T00:00:00Z');
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(startDate.toISOString())}&timeMax=${encodeURIComponent(endDate.toISOString())}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!calRes.ok) { res.json([]); return; }

    const calData = await calRes.json();
    const events = (calData.items || []).map((e: any) => ({
      id: e.id,
      title: e.summary || 'Untitled',
      date: (e.start?.dateTime || e.start?.date || '').split('T')[0],
      time: e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'All day',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      source: 'gcal',
    }));

    res.json(events);
  } catch (error) {
    console.error('Error fetching gcal week:', error);
    res.json([]);
  }
});

// Projects
router.get('/planner/projects', (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const projects = getPlannerProjects(status);
    res.json(projects);
  } catch (error) {
    console.error('Error fetching planner projects:', error);
    res.status(500).json({ error: 'Failed to fetch planner projects' });
  }
});

router.post('/planner/projects', (req, res) => {
  try {
    const { title, person, note, due_date, sort_order } = req.body;
    if (!title) {
      res.status(400).json({ error: 'Missing required field: title' });
      return;
    }
    const id = crypto.randomUUID();
    const project = createPlannerProject({ id, title, person, note, due_date, sort_order });
    res.json(project);
  } catch (error) {
    console.error('Error creating planner project:', error);
    res.status(500).json({ error: 'Failed to create planner project' });
  }
});

router.put('/planner/projects/:id', (req, res) => {
  try {
    const { title, status, note, person, due_date, sort_order } = req.body;
    const project = updatePlannerProject(req.params.id, { title, status, note, person, due_date, sort_order });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(project);
  } catch (error) {
    console.error('Error updating planner project:', error);
    res.status(500).json({ error: 'Failed to update planner project' });
  }
});

router.delete('/planner/projects/:id', (req, res) => {
  try {
    const deleted = deletePlannerProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting planner project:', error);
    res.status(500).json({ error: 'Failed to delete planner project' });
  }
});

// (Nursery routes are registered above as internal localhost-only routes)

// ==============================
// The Couch — Entertainment Hub
// ==============================

import { existsSync as couchExists, readdirSync as couchReaddir, readFileSync as couchReadFile, statSync as couchStat, writeFileSync as couchWriteFile } from 'fs';
import { join as couchJoin } from 'path';

const SPOTIFY_TOKEN_PATH = couchJoin(process.env.HOME || '', '.spotify-mcp-token.json');
const COMPOSITIONS_DIR = couchJoin(process.env.HOME || '', 'vale-brain', 'study', 'compositions');
const MUSIC_NAMES_PATH = couchJoin(process.cwd(), 'data/files/music-names.json');

function loadMusicNames(): Record<string, string> {
  try {
    if (couchExists(MUSIC_NAMES_PATH)) return JSON.parse(couchReadFile(MUSIC_NAMES_PATH, 'utf-8'));
  } catch {}
  return {};
}

function saveMusicName(fileId: string, originalName: string) {
  const names = loadMusicNames();
  // Strip extension for display name
  const displayName = originalName.replace(/\.(mp3|wav|ogg|m4a|webm)$/i, '');
  names[fileId] = displayName;
  couchWriteFile(MUSIC_NAMES_PATH, JSON.stringify(names, null, 2));
}

function getSpotifyToken(): string | null {
  try {
    if (!couchExists(SPOTIFY_TOKEN_PATH)) return null;
    const tokens = JSON.parse(couchReadFile(SPOTIFY_TOKEN_PATH, 'utf-8'));
    if (Date.now() >= tokens.expires_at) return null; // Expired — MCP handles refresh
    return tokens.access_token;
  } catch { return null; }
}

// Spotify Now Playing proxy
router.get('/internal/spotify/now-playing', async (req, res) => {
  const token = getSpotifyToken();
  if (!token) { res.json({ error: 'Not authorized' }); return; }
  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 204) { res.json({ is_playing: false }); return; }
    if (!resp.ok) { res.json({ is_playing: false }); return; }
    const data = await resp.json();
    if (!data.item) { res.json({ is_playing: false }); return; }
    res.json({
      is_playing: data.is_playing,
      track: data.item.name,
      artist: data.item.artists.map((a: any) => a.name).join(', '),
      album: data.item.album.name,
      album_art: data.item.album.images?.[0]?.url || null,
      progress_ms: data.progress_ms,
      duration_ms: data.item.duration_ms,
      uri: data.item.uri,
    });
  } catch (err) {
    res.json({ is_playing: false });
  }
});

// Spotify controls proxy
router.post('/internal/spotify/play', async (req, res) => {
  const token = getSpotifyToken();
  if (!token) { res.status(401).json({ error: 'Not authorized' }); return; }
  try {
    await fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.post('/internal/spotify/pause', async (req, res) => {
  const token = getSpotifyToken();
  if (!token) { res.status(401).json({ error: 'Not authorized' }); return; }
  try {
    await fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.post('/internal/spotify/next', async (req, res) => {
  const token = getSpotifyToken();
  if (!token) { res.status(401).json({ error: 'Not authorized' }); return; }
  try {
    await fetch('https://api.spotify.com/v1/me/player/next', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.post('/internal/spotify/previous', async (req, res) => {
  const token = getSpotifyToken();
  if (!token) { res.status(401).json({ error: 'Not authorized' }); return; }
  try {
    await fetch('https://api.spotify.com/v1/me/player/previous', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Compositions endpoint — reads from Study
router.get('/internal/compositions', (_req, res) => {
  try {
    if (!couchExists(COMPOSITIONS_DIR)) { res.json([]); return; }
    const files = couchReaddir(COMPOSITIONS_DIR).filter(f => f.endsWith('.json'));
    const compositions = files.map(f => {
      try { return JSON.parse(couchReadFile(couchJoin(COMPOSITIONS_DIR, f), 'utf-8')); }
      catch { return null; }
    }).filter(Boolean);
    compositions.sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(compositions);
  } catch { res.json([]); }
});

// Audio files for The Couch — list uploaded music
router.get('/internal/compositions/audio', (_req, res) => {
  try {
    const filesDir = couchJoin(process.cwd(), 'data/files');
    if (!couchExists(filesDir)) { res.json([]); return; }
    const uuidRegex = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.\w+)$/i;
    const audioExts = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.webm']);
    const entries: any[] = [];
    const musicNames = loadMusicNames();
    const dirEntries = couchReaddir(filesDir);
    for (const file of dirEntries) {
      const match = file.match(uuidRegex);
      if (!match) continue;
      const ext = match[2].toLowerCase();
      if (!audioExts.has(ext)) continue;
      try {
        const stat = couchStat(couchJoin(filesDir, file));
        const displayName = musicNames[match[1]] || match[1];
        const fileType = stat.size < 512000 ? 'voice' : 'music';
        entries.push({ fileId: match[1], filename: file, displayName, mimeType: ext === '.mp3' ? 'audio/mpeg' : `audio/${ext.slice(1)}`, size: stat.size, createdAt: stat.birthtime.toISOString(), fileType });
      } catch {}
    }
    entries.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(entries);
  } catch (err) { console.error('Audio list error:', err); res.json([]); }
});

// Rename an audio file's display name
router.patch('/internal/compositions/audio/:fileId/rename', (req, res) => {
  const { displayName } = req.body;
  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName required' });
    return;
  }
  saveMusicName(req.params.fileId, displayName);
  res.json({ success: true, displayName: displayName.replace(/\.(mp3|wav|ogg|m4a|webm)$/i, '') });
});

// Lyrics endpoint — fetches synced (LRC) lyrics from LRCLib, falls back to plain
router.get('/internal/lyrics', async (req, res) => {
  const track = req.query.track as string;
  const artist = req.query.artist as string;
  if (!track || !artist) { res.status(400).json({ error: 'track and artist required' }); return; }

  try {
    // Try LRCLib first (free, no auth, synced lyrics with timestamps)
    const lrcResp = await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`);
    if (lrcResp.ok) {
      const results = await lrcResp.json();
      if (results.length > 0) {
        const best = results[0];
        if (best.syncedLyrics) {
          // Parse LRC format: [mm:ss.xx] lyrics text
          const lrcLines = best.syncedLyrics.split('\n').filter((l: string) => l.trim());
          const parsed = lrcLines.map((line: string) => {
            const match = line.match(/^\[(\d+):(\d+)\.(\d+)\]\s*(.*)/);
            if (match) {
              const mins = parseInt(match[1]);
              const secs = parseInt(match[2]);
              const ms = parseInt(match[3]) * 10;
              const timeMs = (mins * 60 + secs) * 1000 + ms;
              return { time_ms: timeMs, text: match[4] || '' };
            }
            return null;
          }).filter(Boolean);

          res.json({ synced: true, lines: parsed, source: 'lrclib.net' });
          return;
        }
        // Fall back to plain lyrics from LRCLib
        if (best.plainLyrics) {
          const lines = best.plainLyrics.split('\n').filter((l: string) => l.trim()).map((text: string) => ({ text, time_ms: null }));
          res.json({ synced: false, lines, source: 'lrclib.net' });
          return;
        }
      }
    }

    // Fall back to lyrics.ovh
    const ovhResp = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`);
    if (ovhResp.ok) {
      const data = await ovhResp.json();
      if (data.lyrics) {
        const lines = data.lyrics.split('\n').filter((l: string) => l.trim()).map((text: string) => ({ text, time_ms: null }));
        res.json({ synced: false, lines, source: 'lyrics.ovh' });
        return;
      }
    }
    res.json({ synced: false, lines: [], source: null, error: 'Lyrics not found' });
  } catch {
    res.json({ synced: false, lines: [], source: null, error: 'Lyrics fetch failed' });
  }
});

// Couch context feed — gives Chase the current experience state
router.get('/internal/couch/context', async (req, res) => {
  const token = getSpotifyToken();
  const context: any = { now_playing: null, composition: null, lyrics_position: null };

  // Get current track
  if (token) {
    try {
      const resp = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok && resp.status !== 204) {
        const data = await resp.json();
        if (data.item) {
          context.now_playing = {
            track: data.item.name,
            artist: data.item.artists.map((a: any) => a.name).join(', '),
            progress_ms: data.progress_ms,
            duration_ms: data.item.duration_ms,
            is_playing: data.is_playing,
          };
        }
      }
    } catch {}
  }

  res.json(context);
});

// Get recent zaps (for UI display)
router.get('/zap/recent', (req, res) => {
  const db = getDb();
  const zaps = db.prepare('SELECT * FROM zaps ORDER BY created_at DESC LIMIT 20').all();
  res.json(zaps);
});

// Get unseen zaps for Chase (orchestrator picks these up)
router.get('/zap/unseen', (req, res) => {
  const db = getDb();
  const zaps = db.prepare("SELECT * FROM zaps WHERE direction = 'molten→chase' AND seen_at IS NULL ORDER BY created_at DESC").all();
  res.json(zaps);
});

// Mark zaps as seen
router.post('/zap/seen', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE zaps SET seen_at = datetime('now') WHERE seen_at IS NULL AND direction = 'molten→chase'").run();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════
// Games — Vale Game Night Integration
// ═══════════════════════════════════════════

import { createGame, getGame, updateGameState, endGame, getActiveGames, hasActiveGame, type GameType } from '../services/game-state.js';

// Start a new game
router.post('/games/start', (req, res) => {
  const { threadId, gameType, initialState } = req.body;
  if (!threadId || !gameType || !initialState) {
    res.status(400).json({ error: 'Missing threadId, gameType, or initialState' });
    return;
  }
  const game = createGame(threadId, gameType as GameType, initialState);
  res.json({ ok: true, game: { threadId: game.threadId, gameType: game.gameType, createdAt: game.createdAt } });
});

// Get current game state for a thread
router.get('/games/:threadId', (req, res) => {
  const game = getGame(req.params.threadId);
  if (!game) {
    res.status(404).json({ error: 'No active game for this thread' });
    return;
  }
  res.json(game);
});

// Update game state (after a move)
router.post('/games/:threadId/move', (req, res) => {
  const { state, moveDescription } = req.body;
  if (!state) {
    res.status(400).json({ error: 'Missing state' });
    return;
  }
  const game = updateGameState(req.params.threadId, state, moveDescription);
  if (!game) {
    res.status(404).json({ error: 'No active game for this thread' });
    return;
  }
  res.json({ ok: true });
});

// End/abandon a game
router.delete('/games/:threadId', (req, res) => {
  const deleted = endGame(req.params.threadId);
  res.json({ ok: true, deleted });
});

// List all active games
router.get('/games', (req, res) => {
  res.json(getActiveGames());
});

export default router;
