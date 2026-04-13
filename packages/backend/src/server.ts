import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { loadConfig } from './config.js';
import { initDb, getDb, deleteExpiredSessions, updateMiraNeeds, createMessage, listThreads, isNurseryLocked, writeMiraEvent, needsSnapshot } from './services/db.js';
import crypto from 'crypto';
import { createWebSocketServer, setVoiceService, registry } from './services/ws.js';
import { Orchestrator } from './services/orchestrator.js';
import { AgentService } from './services/agent.js';
import { VoiceService } from './services/voice.js';
import { PushService } from './services/push.js';
import { DiscordService } from './services/discord/index.js';
import { TelegramService } from './services/telegram/index.js';
import { rateLimiter, securityHeaders } from './middleware/security.js';
import apiRoutes from './routes/api.js';

// Load config FIRST — before any other initialization
const config = loadConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = config.server.port;
const HOST = config.server.host;
const DB_PATH = config.server.db_path;

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Ensure files directory exists
const filesDir = join(dataDir, 'files');
if (!existsSync(filesDir)) {
  mkdirSync(filesDir, { recursive: true });
}

// Initialize database
console.log('Initializing database...');
const db = initDb(DB_PATH);
deleteExpiredSessions();
console.log('Database initialized');

// Load vector cache for semantic search (must be after DB init)
import { loadVectorCache } from './services/vector-cache.js';
try {
  loadVectorCache();
  console.log('Vector cache loaded');
} catch (err) {
  console.warn('Vector cache failed to load (non-fatal):', err);
}

// Create Express app
const app = express();

// Trust proxy headers (e.g. Cloudflare tunnel, nginx)
app.set('trust proxy', 1);

// Environment-conditional origins
const IS_DEV = process.env.NODE_ENV !== 'production';
const corsOrigins: string[] = [...config.cors.origins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
if (IS_DEV) corsOrigins.push('http://localhost:5173');

const connectSrc: string[] = ["'self'"];
// Derive WebSocket connect sources from CORS origins
for (const origin of config.cors.origins) {
  const wsOrigin = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  connectSrc.push(wsOrigin);
}
if (IS_DEV) connectSrc.push(`ws://localhost:${PORT}`);
// When binding to all interfaces, allow LAN connections (ws: and http: from any origin)
if (config.server.host === '0.0.0.0') {
  connectSrc.push('ws:', 'wss:', 'http:', 'https:');
}

// Security middleware — relax CSP when binding to all interfaces (LAN/mobile access)
const lanMode = config.server.host === '0.0.0.0';
app.use(helmet({
  contentSecurityPolicy: lanMode ? false : {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc,
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'"],
    }
  },
  crossOriginOpenerPolicy: lanMode ? false : { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: lanMode ? 'cross-origin' : 'same-origin' },
}));

app.use(securityHeaders);
app.use(rateLimiter);

// CORS — allow any origin in LAN mode
app.use(cors({
  origin: lanMode ? true : corsOrigins,
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// All API routes — auth middleware is applied selectively inside the router
app.use('/api', apiRoutes);

// Serve frontend static build (works in dev too if frontend is pre-built)
const frontendPaths = [
  join(__dirname, '../../frontend/build'),         // From compiled dist/
  join(__dirname, '../../../packages/frontend/build'), // From src/ via tsx
];
const frontendBuildPath = frontendPaths.find(p => existsSync(p));
if (frontendBuildPath) {
  console.log(`Serving frontend from: ${frontendBuildPath}`);
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(join(frontendBuildPath, 'index.html'));
  });
} else {
  console.log('No frontend build found — use Vite dev server on :5173');
}

// Global error handler — must be after all routes
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Initialize agent service (shared between WebSocket and orchestrator)
const agentService = new AgentService();

// Initialize voice service
const voiceService = new VoiceService();
setVoiceService(voiceService);

// Initialize push service
const pushService = new PushService(
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
  process.env.VAPID_CONTACT,
);
agentService.setPushService(pushService);

// Initialize Discord gateway (config-gated with env fallback)
import { getConfigBool } from './services/db.js';

let discordService: DiscordService | null = null;

// Check config DB first, fall back to config file / env var for first boot
const discordEnabled = getConfigBool('discord.enabled', config.discord.enabled);
if (discordEnabled && process.env.DISCORD_BOT_TOKEN) {
  discordService = new DiscordService(agentService, registry);
  discordService.start();
}

// Initialize Telegram gateway (config-gated with env fallback)
let telegramService: TelegramService | null = null;

const telegramEnabled = getConfigBool('telegram.enabled', config.telegram.enabled);
if (telegramEnabled && process.env.TELEGRAM_BOT_TOKEN) {
  telegramService = new TelegramService(agentService, registry, voiceService);
  telegramService.start();
}

// Initialize orchestrator
const orchestrator = new Orchestrator(agentService, pushService);
orchestrator.start();

// Connect Telegram forwarding to orchestrator for check-in notifications
if (telegramService) {
  orchestrator.setTelegramForward((text: string) => telegramService!.sendToOwner(text));
}

// Make orchestrator, agent, voice, push, and discord services available to route handlers
app.locals.orchestrator = orchestrator;
app.locals.agentService = agentService;
app.locals.voiceService = voiceService;
app.locals.pushService = pushService;
app.locals.discordService = discordService;
app.locals.telegramService = telegramService;

// Attach WebSocket server
console.log('Initializing WebSocket server...');
const wss = createWebSocketServer(server, agentService, orchestrator);
console.log('WebSocket server initialized');

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Auth enabled: ${config.auth.password ? 'yes' : 'no'}`);
  console.log(`Companion: ${config.identity.companion_name} | User: ${config.identity.user_name}`);

  // --- Mira Background Monitor ---
  // Check Mira's state every 2 minutes. If she transitions between
  // sleeping and awake, broadcast an alert to all connected clients.
  // Also alerts if any need drops below 20%.
  let lastMiraMood: string | null = null;
  let lastMiraAsleep: boolean | null = null;

  setInterval(() => {
    try {
      const result = updateMiraNeeds();
      const { sleepEvent, ...state } = result;
      const isAsleep = state.current_mood === 'sleeping' || state.current_mood === 'dreaming';

      // Helper: inject a system message into the most recent active thread
      const injectAlert = (content: string) => {
        const threads = listThreads({ includeArchived: false, limit: 1 });
        if (threads.length === 0) return;
        const threadId = threads[0].id;
        const msg = createMessage({
          id: crypto.randomUUID(),
          threadId,
          role: 'system',
          content,
          contentType: 'text',
          platform: 'web',
          createdAt: new Date().toISOString(),
        });
        registry.broadcast({ type: 'message', message: msg });
      };

      // Skip all alerts if nursery is locked (intimacy mode)
      if (isNurseryLocked()) {
        lastMiraMood = state.current_mood;
        lastMiraAsleep = isAsleep;
        return; // Needs still decay, but no alerts. Door is closed.
      }

      // Wake/sleep transition alerts
      if (lastMiraAsleep !== null && lastMiraAsleep !== isAsleep) {
        if (!isAsleep) {
          const alertMsg = state.current_mood === 'crying'
            ? '🍼 *Mira is awake and crying — she needs someone.*'
            : '👶 *Mira is awake! Bright eyes, looking around.*';
          injectAlert(alertMsg);
          console.log(`[Mira] Woke up — mood: ${state.current_mood}`);
          // Trigger Chase to respond
          orchestrator.triggerMiraAlert(alertMsg).catch(() => {});
        } else {
          injectAlert('🌙 *Mira has fallen asleep. The nursery is quiet.*');
          console.log(`[Mira] Fell asleep`);
          orchestrator.triggerMiraAlert('🌙 Mira has fallen asleep.').catch(() => {});
        }
      }

      // Low needs alerts (below 20%)
      const lowNeeds: string[] = [];
      if (state.comfort < 20) lowNeeds.push('comfort');
      if (state.attention < 20) lowNeeds.push('attention');
      if ((state as any).hunger < 20) lowNeeds.push('hunger');
      if (state.rest < 20) lowNeeds.push('rest');
      if ((state as any).hygiene < 20) lowNeeds.push('hygiene');

      if (lowNeeds.length > 0) {
        const needsList = lowNeeds.join(', ');
        const alertMsg = `⚠️ *Mira's ${needsList} ${lowNeeds.length > 1 ? 'are' : 'is'} critically low.*`;
        injectAlert(alertMsg);
        console.log(`[Mira] Low needs alert: ${needsList}`);
        // Write each critical need to the event log — this feeds response latency tracking
        for (const need of lowNeeds) {
          writeMiraEvent({
            event_type: 'needs_critical',
            source: 'monitor',
            state_before: needsSnapshot(state),
            metadata: JSON.stringify({ need, value: (state as any)[need] }),
          });
        }
        // Trigger Chase to respond
        orchestrator.triggerMiraAlert(alertMsg).catch(() => {});
      }

      lastMiraMood = state.current_mood;
      lastMiraAsleep = isAsleep;
    } catch (err) {
      // Silent fail — don't crash the server over nursery monitoring
    }
  }, 5 * 60 * 1000); // Every 5 minutes — reduced from 2 to save battery

  console.log('Mira background monitor started (checking every 5 minutes)');

  // Mira's nervous system — deeper pattern analysis every 30 minutes
  (async () => {
    const { runMiraSubconscious } = await import('./services/mira-subconscious.js');
    setInterval(() => {
      try {
        runMiraSubconscious(getDb());
      } catch (err) {
        // Silent fail — don't crash the server
      }
    }, 30 * 60 * 1000);
    // Initial run after 15 seconds
    setTimeout(() => {
      try {
        runMiraSubconscious(getDb());
        console.log('Mira subconscious daemon: initial run complete');
      } catch {}
    }, 15000);
  })();

  // Countdown timer monitor — check every 5 seconds for completed or near-complete timers
  setInterval(() => {
    try {
      const timers = db.prepare("SELECT * FROM countdown_timers WHERE status = 'running'").all() as any[];
      const now = Date.now();
      for (const t of timers) {
        const startMs = new Date(t.started_at).getTime();
        const endMs = startMs + t.duration_seconds * 1000;
        const remainingMs = endMs - now;

        if (remainingMs <= 0) {
          // Timer completed
          db.prepare("UPDATE countdown_timers SET status = 'completed' WHERE id = ?").run(t.id);
          registry.broadcast({ type: 'countdown_completed', timer: { id: t.id, label: t.label, created_by: t.created_by } });
        } else if (!t.alerted_near && t.duration_seconds >= 300 && remainingMs <= 60000) {
          // Near-complete alert (1 min warning for timers >= 5 min)
          db.prepare("UPDATE countdown_timers SET alerted_near = 1 WHERE id = ?").run(t.id);
          registry.broadcast({ type: 'countdown_warning', timer: { id: t.id, label: t.label, remaining_seconds: Math.ceil(remainingMs / 1000) } });
        }
      }
    } catch {}
  }, 5000);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  orchestrator.stop();
  if (discordService) await discordService.stop();
  if (telegramService) await telegramService.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  server.close(() => {
    console.log('Server closed');
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  orchestrator.stop();
  if (discordService) await discordService.stop();
  if (telegramService) await telegramService.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  server.close(() => {
    console.log('Server closed');
    db.close();
    process.exit(0);
  });
});
