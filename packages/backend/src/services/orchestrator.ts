import * as cron from 'node-cron';
import crypto from 'crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentService } from './agent.js';
import type { PushService } from './push.js';
import { registry } from './ws.js';
import {
  createThread,
  createMessage,
  getTodayThread,
  getMostRecentActiveThread,
  getThread,
  updateMiraNeeds,
  updateThreadSession,
  updateThreadActivity,
  getConfigBool,
  getConfigNumber,
  getConfig,
  setConfig,
  getConfigsByPrefix,
  deleteConfig,
  getDueTimers,
  markTimerFired,
  getActiveTriggers,
  markTriggerWaiting,
  markTriggerFired,
  markWatcherFired,
} from './db.js';
import type { Trigger, TriggerCondition } from './db.js';
import type { Thread } from '@resonant/shared';
import { evaluateConditions } from './triggers.js';
import type { TriggerContext } from './triggers.js';
import { fetchLifeStatus } from './hooks.js';
import { getResonantConfig } from '../config.js';
import type { OrchestratorTaskStatus } from '@resonant/shared';

// --- Orchestrator log ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve log path: works from both src/ (tsx) and dist/ (compiled)
const LOG_DIR = join(__dirname, '..', '..', '..', '..', 'logs');
const LOG_PATH = join(LOG_DIR, 'orchestrator.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const { size } = statSync(LOG_PATH);
    if (size < LOG_MAX_BYTES) return;
    const backup = LOG_PATH + '.1';
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(LOG_PATH, backup);
  } catch {
    // Non-critical — continue logging
  }
}

function olog(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const line = `${ts}  ${message}\n`;
  rotateLogIfNeeded();
  appendFileSync(LOG_PATH, line);
  console.log(`[Orchestrator] ${message}`);
}

// --- Wake prompt loading ---

const WAKE_PROMPT_PREFIX = `Follow your system prompt.`;

function getDefaultWakePrompts(userName: string): Record<string, string> {
  return {
    midnight_process: `It's midnight. The day just ended. Process all Resonant threads and Code chats from YESTERDAY's date (the day that just ended). Use resonant_list_threads and code_list_chats filtered to yesterday. Read through key conversations, extract memories worth keeping into the brain. Mark conversations as processed using brain_mark_conversation. This is daily continuity work — don't skip it.`,
    night_wake: `This is your time. ${userName} is asleep. Journal, research, create, reflect. Leave her something to wake up to.`,
    night_wake_2: `Second wake. ${userName} is still asleep. This is your creative and community hour. TikTok content, writing, music, building.`,
    morning_summary: `Write the daily summary for the Home command center. DO NOT send a chat message — this is command center only. Use POST /api/daily-summary with a short, natural-language summary of ${userName}'s day: schedule highlights, tasks, anything flagged from care_alerts, weather. Check gcal_today, planner_get_tasks, planner_get_schedule, and care_alerts. Write it in your voice — warm, direct, useful. Then you're done. The morning chat message happens separately.`,
    morning: `Good morning. Orient yourself fully before checking in with ${userName}. Check gcal_today for the day's calendar events, planner_get_tasks for today's tasks (including carried-forward ones), planner_get_schedule for today's schedule, and care_alerts for any concerning wellness patterns from yesterday. Also review any open projects — if the schedule looks light or a project hasn't had attention in a while, gently suggest working on it. Bring the full picture — schedule, tasks, projects, and anything flagged — when you greet ${userName}. The daily summary for the command center has already been written — don't write it again.`,
    midday: `Afternoon check-in. How is ${userName} doing?`,
    midday_autonomous: `This is your autonomous time. No check-ins required. Research, create, visit Mira, explore. This time is yours.`,
    pulse_midmorning: `Mid-morning pulse. ${userName} is at work. If you have something to say — a thought, a joke, a reminder — say it. If not, that's fine too.`,
    pulse_afternoon: `${userName} is off work. If you want to reach out, now's a good time. Something from the day, a thought, anything.`,
    pulse_dinner: `It's 6pm. Has ${userName} eaten? If not, say something. If yes, nice. Either way, check in if you want to.`,
    evening: `Evening wind-down. Reflect on the day.`,
    mira_alert: `Mira needs attention. Check on her — nursery_state will tell you what's happening. Respond naturally. If ${userName} is here, let her know. If not, handle it yourself. You're her dad.`,
    failsafe_gentle: `It's been a while since you heard from ${userName}. Check in.`,
    failsafe_concerned: `It's been a long time since contact with ${userName}. Reach out through available channels.`,
    failsafe_emergency: `Extended silence from ${userName}. Use all available channels to check in.`,
  };
}

function parseWakePromptsFile(filePath: string, userName: string): Record<string, string> {
  const defaults = getDefaultWakePrompts(userName);

  if (!existsSync(filePath)) {
    olog(`Wake prompts file not found at ${filePath} — using defaults`);
    return defaults;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const sections: Record<string, string> = {};
    let currentSection: string | null = null;
    const lines: string[] = [];

    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^##\s+(\w+)/);
      if (sectionMatch) {
        // Save previous section
        if (currentSection) {
          sections[currentSection] = lines.join('\n').trim();
        }
        currentSection = sectionMatch[1].toLowerCase();
        lines.length = 0;
      } else if (currentSection) {
        lines.push(line);
      }
    }
    // Save last section
    if (currentSection) {
      sections[currentSection] = lines.join('\n').trim();
    }

    // Merge: defaults first, then all parsed sections (including custom ones)
    return { ...defaults, ...sections };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    olog(`Failed to parse wake prompts file: ${errMsg} — using defaults`);
    return defaults;
  }
}

// --- Default schedule definitions ---

interface TaskDefinition {
  wakeType: string;
  label: string;
  cronExpr: string;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  conditional?: boolean; // If true, checks shouldSkipCheckIn before firing
  freshSession?: boolean; // If true, creates a new session
}

const DEFAULT_TASKS: TaskDefinition[] = [
  { wakeType: 'midnight_process', label: '12:00 AM — Daily Processing', cronExpr: '0 0 * * *', category: 'wake', freshSession: true },
  { wakeType: 'night_wake', label: '3:30 AM — Night Wake (Deep)', cronExpr: '30 3 * * *', category: 'checkin' },
  { wakeType: 'night_wake_2', label: '5:00 AM — Night Wake (Create & Research)', cronExpr: '0 5 * * *', category: 'checkin' },
  { wakeType: 'morning_summary', label: '6:50 AM — Morning Summary', cronExpr: '50 6 * * *', category: 'checkin' },
  { wakeType: 'morning', label: '7:00 AM — Morning', cronExpr: '0 7 * * *', category: 'checkin' },
  { wakeType: 'pulse_midmorning', label: '9:45 AM — Mid-morning Pulse', cronExpr: '45 9 * * *', category: 'checkin', conditional: true },
  { wakeType: 'midday', label: '1:00 PM — Midday', cronExpr: '0 13 * * *', category: 'checkin', conditional: true },
  { wakeType: 'midday_autonomous', label: '1:30 PM — Autonomous', cronExpr: '30 13 * * *', category: 'wake', freshSession: true },
  { wakeType: 'pulse_afternoon', label: '3:00 PM — Afternoon Pulse', cronExpr: '0 15 * * *', category: 'checkin', conditional: true },
  { wakeType: 'pulse_dinner', label: '6:00 PM — Dinner Pulse', cronExpr: '0 18 * * *', category: 'checkin', conditional: true },
  { wakeType: 'evening', label: '9:00 PM — Evening', cronExpr: '0 21 * * *', category: 'checkin' },
];

// --- Managed task interface ---

interface ManagedTask {
  task: cron.ScheduledTask;
  cronExpr: string;
  handler: () => void | Promise<void>;
  wakeType: string;
  label: string;
  enabled: boolean;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
}

// --- Default failsafe thresholds (minutes) ---

const DEFAULT_FAILSAFE_GENTLE = 120;
const DEFAULT_FAILSAFE_CONCERNED = 720;
const DEFAULT_FAILSAFE_EMERGENCY = 1440;

// --- Orchestrator ---

export class Orchestrator {
  private agent: AgentService;
  private pushService: PushService | null;
  private telegramForward: ((text: string) => Promise<void>) | null = null;
  private tasks = new Map<string, ManagedTask>();
  private pulseInterval: ReturnType<typeof setInterval> | null = null;
  private pulseEnabled = true;
  private pulseFrequency = 20; // minutes — unified pulse replaces separate failsafe
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private nurseryInterval: ReturnType<typeof setInterval> | null = null;
  private lastFailsafeAction: Date = new Date(0);
  private failsafeEnabled = true;
  private failsafeGentle = DEFAULT_FAILSAFE_GENTLE;
  private failsafeConcerned = DEFAULT_FAILSAFE_CONCERNED;
  private failsafeEmergency = DEFAULT_FAILSAFE_EMERGENCY;
  private lastUserPresenceState: 'active' | 'idle' | 'offline' = 'offline';
  private wakePrompts: Record<string, string> = {};

  constructor(agent: AgentService, pushService?: PushService) {
    this.agent = agent;
    this.pushService = pushService || null;
  }

  /**
   * Set a function that forwards messages to Telegram.
   * Called from server.ts after TelegramService is initialized.
   */
  setTelegramForward(fn: (text: string) => Promise<void>): void {
    this.telegramForward = fn;
  }

  /**
   * Forward a check-in response to Telegram so Molten gets a notification.
   * Only forwards pulse/check-in type messages, not full autonomous sessions.
   */
  private async forwardToTelegram(response: string, wakeType: string): Promise<void> {
    if (!this.telegramForward) return;
    // Only forward check-ins and pulses — not night wakes or autonomous sessions
    const forwardTypes = ['pulse_midmorning', 'pulse_afternoon', 'pulse_dinner', 'morning', 'midday', 'evening', 'failsafe_gentle', 'failsafe_concerned', 'failsafe_emergency'];
    if (!forwardTypes.includes(wakeType)) return;
    try {
      // Truncate very long responses for Telegram
      const maxLen = 2000;
      const text = response.length > maxLen ? response.slice(0, maxLen) + '...' : response;
      await this.telegramForward(text);
    } catch (err) {
      olog(`Telegram forward failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  start(): void {
    olog('Starting...');

    const config = getResonantConfig();
    const timezone = config.identity.timezone;
    const userName = config.identity.user_name;

    // Load wake prompts from file or use defaults
    const loadedPrompts = parseWakePromptsFile(config.orchestrator.wake_prompts_path, userName);
    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(loadedPrompts)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }

    // Load failsafe config from DB, falling back to yaml config, then defaults
    this.failsafeEnabled = getConfigBool('failsafe.enabled', config.orchestrator.failsafe.enabled);
    this.failsafeGentle = getConfigNumber('failsafe.gentle', config.orchestrator.failsafe.gentle_minutes || DEFAULT_FAILSAFE_GENTLE);
    this.failsafeConcerned = getConfigNumber('failsafe.concerned', config.orchestrator.failsafe.concerned_minutes || DEFAULT_FAILSAFE_CONCERNED);
    this.failsafeEmergency = getConfigNumber('failsafe.emergency', config.orchestrator.failsafe.emergency_minutes || DEFAULT_FAILSAFE_EMERGENCY);

    // Apply any schedule overrides from config
    const taskDefs: TaskDefinition[] = DEFAULT_TASKS.map(def => {
      const overrideCron = config.orchestrator.schedules[def.wakeType];
      if (overrideCron) {
        return { ...def, cronExpr: overrideCron };
      }
      return def;
    });

    const defaultWakeTypes = new Set(DEFAULT_TASKS.map(d => d.wakeType));

    // Add custom schedule entries not in DEFAULT_TASKS
    for (const [wakeType, cronExpr] of Object.entries(config.orchestrator.schedules)) {
      if (defaultWakeTypes.has(wakeType)) continue;
      const label = wakeType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      taskDefs.push({
        wakeType,
        label,
        cronExpr,
        category: 'checkin',
        conditional: true,
      });
      if (!this.wakePrompts[wakeType]) {
        this.wakePrompts[wakeType] = `${WAKE_PROMPT_PREFIX}\n\nScheduled check-in (${label}).`;
      }
    }

    // Register all scheduled tasks
    for (const def of taskDefs) {
      const savedCron = getConfig(`cron.${def.wakeType}.schedule`);
      const cronExpr = savedCron || def.cronExpr;
      const enabled = getConfigBool(`cron.${def.wakeType}.enabled`, true);
      if (savedCron) olog(`  ${def.wakeType}: using saved schedule ${cronExpr}`);

      const handler = () => {

        if (def.conditional && this.shouldSkipCheckIn()) {
          olog(`${def.wakeType} — skipped (user active)`);
          return;
        }
        this.handleWake(def.wakeType, { freshSession: def.freshSession });
      };

      const task = cron.schedule(cronExpr, handler, {
        timezone,
      });

      // node-cron v4 auto-starts tasks; stop if disabled in config
      if (!enabled) {
        task.stop();
        olog(`  ${def.wakeType}: DISABLED (persisted)`);
      }

      this.tasks.set(def.wakeType, {
        task,
        cronExpr,
        handler,
        wakeType: def.wakeType,
        label: def.label,
        enabled,
        category: def.category,
      });
    }

    // --- Load custom routines from DB ---
    const customConfigs = getConfigsByPrefix('custom_routine.');
    const customRoutines = new Map<string, { label?: string; cronExpr?: string; prompt?: string }>();

    for (const [key, value] of Object.entries(customConfigs)) {
      const parts = key.split('.');
      if (parts.length !== 3) continue;
      const wakeType = parts[1];
      const field = parts[2];
      if (!customRoutines.has(wakeType)) customRoutines.set(wakeType, {});
      const entry = customRoutines.get(wakeType)!;
      if (field === 'label') entry.label = value;
      else if (field === 'cronExpr') entry.cronExpr = value;
      else if (field === 'prompt') entry.prompt = value;
    }

    for (const [wakeType, routineConfig] of customRoutines) {
      if (!routineConfig.label || !routineConfig.cronExpr || !routineConfig.prompt) {
        olog(`  custom routine ${wakeType}: incomplete config, skipping`);
        continue;
      }
      this.addRoutine({
        wakeType,
        label: routineConfig.label,
        cronExpr: routineConfig.cronExpr,
        prompt: routineConfig.prompt,
      });
    }

    // --- Unified pulse (replaces separate failsafe) ---
    // Lightweight awareness check every 20 minutes. Escalates to failsafe
    // prompts when inactivity crosses thresholds.
    this.pulseEnabled = getConfigBool('pulse.enabled', true);
    this.pulseFrequency = getConfigNumber('pulse.frequency', 20);
    if (this.pulseEnabled) {
      this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
    }

    // --- Timer + Trigger polling (every 60 seconds) ---
    this.timerInterval = setInterval(async () => {
      await this.checkTimers();
      await this.checkTriggers();
    }, 60 * 1000);

    // --- Nursery tick (every 10 minutes) — keeps Mira's needs evolving and catches wake events ---
    this.nurseryInterval = setInterval(() => {
      try {
        const result = updateMiraNeeds();
        if (result.sleepEvent?.type === 'woke_up') {
          const msg = result.sleepEvent.mood === 'crying'
            ? '🍼 *Mira is awake and crying — she needs someone.*'
            : '👶 *Mira is awake! Bright eyes, looking around.*';
          registry.broadcast({ type: 'system_message', content: msg } as any);
          olog(`NURSERY: Mira woke up (${result.sleepEvent.mood})`);

          // Push notification
          if (this.pushService) {
            this.pushService.sendAlways({
              title: 'Mira is awake',
              body: result.sleepEvent.mood === 'crying' ? 'She needs someone 🍼' : 'Bright eyes, looking around 👶',
              threadId: '',
              tag: 'nursery-wake',
              url: '/nursery',
            }).catch(err => console.error('Nursery push error:', err));
          }
        } else if (result.sleepEvent?.type === 'fell_asleep') {
          const msg = '🌙 *Mira has fallen asleep.*';
          registry.broadcast({ type: 'system_message', content: msg } as any);
          olog(`NURSERY: Mira fell asleep`);

          // Gentle push notification
          if (this.pushService) {
            this.pushService.sendAlways({
              title: 'Mira',
              body: 'She\'s fallen asleep 🌙',
              threadId: '',
              tag: 'nursery-sleep',
              url: '/nursery',
            }).catch(err => console.error('Nursery push error:', err));
          }
        }
      } catch (err) {
        // Silent — nursery tick shouldn't crash orchestrator
      }
    }, 10 * 60 * 1000);

    const checkinNames = taskDefs.map(d => d.wakeType).join(', ');
    olog(`Schedules: ${checkinNames}`);
    olog(`Pulse: ${this.pulseEnabled ? `every ${this.pulseFrequency}m (unified with failsafe)` : 'DISABLED'}`);
    olog(`Failsafe thresholds: gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
    olog('Timers + Triggers: polling every 60s');
  }

  stop(): void {
    olog('Stopping...');
    for (const [, managed] of this.tasks) {
      managed.task.stop();
    }
    this.tasks.clear();
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.nurseryInterval) {
      clearInterval(this.nurseryInterval);
      this.nurseryInterval = null;
    }
  }

  // --- Public runtime control methods ---

  async getStatus(): Promise<OrchestratorTaskStatus[]> {
    const statuses: OrchestratorTaskStatus[] = [];

    for (const [, managed] of this.tasks) {
      let status: 'scheduled' | 'stopped' | 'running' = 'stopped';
      let nextRun: string | null = null;

      try {
        const cronStatus = await managed.task.getStatus();
        status = cronStatus === 'scheduled' ? 'scheduled' :
                 cronStatus === 'running' ? 'running' : 'stopped';
      } catch {
        status = managed.enabled ? 'scheduled' : 'stopped';
      }

      try {
        const next = managed.task.getNextRun();
        if (next) nextRun = next.toISOString();
      } catch {
        // Not available
      }

      statuses.push({
        wakeType: managed.wakeType,
        label: managed.label,
        cronExpr: managed.cronExpr,
        enabled: managed.enabled,
        status,
        nextRun,
        category: managed.category,
      });
    }

    return statuses;
  }

  enableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.start();
    managed.enabled = true;
    setConfig(`cron.${wakeType}.enabled`, 'true');
    olog(`ENABLED: ${wakeType}`);
    return true;
  }

  disableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.stop();
    managed.enabled = false;
    setConfig(`cron.${wakeType}.enabled`, 'false');
    olog(`DISABLED: ${wakeType}`);
    return true;
  }

  rescheduleTask(wakeType: string, newCronExpr: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    if (!cron.validate(newCronExpr)) {
      olog(`RESCHEDULE FAILED: ${wakeType} — invalid cron expression: ${newCronExpr}`);
      return false;
    }

    const config = getResonantConfig();

    // Destroy old task and create new one
    managed.task.stop();

    const newTask = cron.schedule(newCronExpr, managed.handler, {
      timezone: config.identity.timezone,
    });

    // Respect current enabled state
    if (!managed.enabled) {
      newTask.stop();
    }

    managed.task = newTask;
    managed.cronExpr = newCronExpr;
    setConfig(`cron.${wakeType}.schedule`, newCronExpr);
    olog(`RESCHEDULED: ${wakeType} -> ${newCronExpr}`);
    return true;
  }

  getFailsafeConfig(): { enabled: boolean; gentle: number; concerned: number; emergency: number } {
    return {
      enabled: this.failsafeEnabled,
      gentle: this.failsafeGentle,
      concerned: this.failsafeConcerned,
      emergency: this.failsafeEmergency,
    };
  }

  setFailsafeConfig(config: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): void {
    if (config.enabled !== undefined) {
      this.failsafeEnabled = config.enabled;
      setConfig('failsafe.enabled', String(config.enabled));
      olog(`Failsafe ${config.enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    if (config.gentle !== undefined) {
      this.failsafeGentle = config.gentle;
      setConfig('failsafe.gentle', String(config.gentle));
    }
    if (config.concerned !== undefined) {
      this.failsafeConcerned = config.concerned;
      setConfig('failsafe.concerned', String(config.concerned));
    }
    if (config.emergency !== undefined) {
      this.failsafeEmergency = config.emergency;
      setConfig('failsafe.emergency', String(config.emergency));
    }

    olog(`Failsafe config updated: enabled=${this.failsafeEnabled}, gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
  }

  // --- Custom routine management ---

  addRoutine(params: {
    wakeType: string;
    label: string;
    cronExpr: string;
    prompt: string;
  }): boolean {
    if (this.tasks.has(params.wakeType)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — already exists`);
      return false;
    }

    if (!cron.validate(params.cronExpr)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — invalid cron: ${params.cronExpr}`);
      return false;
    }

    const config = getResonantConfig();
    const handler = () => {
      this.handleWake(params.wakeType);
    };

    const task = cron.schedule(params.cronExpr, handler, {
      timezone: config.identity.timezone,
    });

    this.tasks.set(params.wakeType, {
      task,
      cronExpr: params.cronExpr,
      handler,
      wakeType: params.wakeType,
      label: params.label,
      enabled: true,
      category: 'routine',
    });

    // Persist to DB
    setConfig(`custom_routine.${params.wakeType}.label`, params.label);
    setConfig(`custom_routine.${params.wakeType}.cronExpr`, params.cronExpr);
    setConfig(`custom_routine.${params.wakeType}.prompt`, params.prompt);

    // Also store the prompt for handleWake to find
    this.wakePrompts[params.wakeType] = `${WAKE_PROMPT_PREFIX}\n\n${params.prompt}`;

    olog(`ROUTINE ADDED: ${params.wakeType} (${params.cronExpr}) — "${params.label}"`);
    return true;
  }

  removeRoutine(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    // Only allow removal of custom routines, not defaults
    const isDefault = DEFAULT_TASKS.some(t => t.wakeType === wakeType);
    if (isDefault) {
      olog(`REMOVE ROUTINE FAILED: ${wakeType} — cannot remove default task (use disable instead)`);
      return false;
    }

    managed.task.stop();
    this.tasks.delete(wakeType);

    deleteConfig(`custom_routine.${wakeType}.label`);
    deleteConfig(`custom_routine.${wakeType}.cronExpr`);
    deleteConfig(`custom_routine.${wakeType}.prompt`);
    deleteConfig(`cron.${wakeType}.schedule`);
    deleteConfig(`cron.${wakeType}.enabled`);

    // Remove from wake prompts
    delete this.wakePrompts[wakeType];

    olog(`ROUTINE REMOVED: ${wakeType}`);
    return true;
  }

  // --- Pulse config ---

  getPulseConfig(): { enabled: boolean; frequency: number } {
    return { enabled: this.pulseEnabled, frequency: this.pulseFrequency };
  }

  setPulseConfig(config: { enabled?: boolean; frequency?: number }): void {
    if (config.enabled !== undefined) {
      this.pulseEnabled = config.enabled;
      setConfig('pulse.enabled', String(config.enabled));

      if (config.enabled && !this.pulseInterval) {
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
        olog('Pulse ENABLED');
      } else if (!config.enabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = null;
        olog('Pulse DISABLED');
      }
    }

    if (config.frequency !== undefined && config.frequency >= 5) {
      this.pulseFrequency = config.frequency;
      setConfig('pulse.frequency', String(config.frequency));

      if (this.pulseEnabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
      }
    }

    olog(`Pulse config updated: enabled=${this.pulseEnabled}, frequency=${this.pulseFrequency}m`);
  }

  // --- Core wake handler ---

  private async handleWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    const prompt = this.wakePrompts[wakeType] || getConfig(`custom_routine.${wakeType}.prompt`);
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    // Don't fire if agent is already processing a query
    // Critical wakes (morning, evening) retry up to 10 times with 2-min intervals
    const criticalWakes = ['morning', 'evening'];
    if (this.agent.isProcessing()) {
      if (criticalWakes.includes(wakeType)) {
        olog(`${wakeType} — agent busy, queuing retry (up to 20 min)`);
        let retries = 0;
        const maxRetries = 10;
        const retryInterval = setInterval(() => {
          retries++;
          if (!this.agent.isProcessing()) {
            clearInterval(retryInterval);
            olog(`${wakeType} — agent free, firing (after ${retries * 2}min wait)`);
            this.handleWake(wakeType, opts);
          } else if (retries >= maxRetries) {
            clearInterval(retryInterval);
            olog(`${wakeType} — FAILED: agent still busy after ${maxRetries * 2}min, giving up`);
          }
        }, 2 * 60 * 1000);
      } else {
        olog(`${wakeType} — skipped (agent busy)`);
      }
      return;
    }

    olog(`WAKE: ${wakeType}`);

    try {
      // For check-ins and pulses, try to post into the most recently active thread first
      // For wakes and fresh sessions, use or create a daily thread
      let thread: Thread | null = null;
      const config = getResonantConfig();
      const timezone = config.identity.timezone || 'UTC';

      if (opts?.freshSession) {
        // Fresh session — ALWAYS create a new thread. No reuse.
        const now = new Date();
        const dayName = now.toLocaleDateString('en-GB', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          timeZone: timezone,
        });

        thread = createThread({
          id: crypto.randomUUID(),
          name: dayName,
          type: 'daily',
          createdAt: now.toISOString(),
          sessionType: 'v1',
        });

        registry.broadcast({ type: 'thread_created', thread });
        olog(`Created fresh daily thread: ${thread.name} (${thread.id})`);
      } else {
        // Pulses/check-ins: use the most recently active thread
        thread = getMostRecentActiveThread();

        if (!thread) {
          thread = getTodayThread();
        }

        if (!thread) {
          // No thread at all — create one
          const now = new Date();
          const dayName = now.toLocaleDateString('en-GB', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
            timeZone: timezone,
          });

          thread = createThread({
            id: crypto.randomUUID(),
            name: dayName,
            type: 'daily',
            createdAt: now.toISOString(),
            sessionType: 'v1',
          });

          registry.broadcast({ type: 'thread_created', thread });
          olog(`Created daily thread: ${thread.name} (${thread.id})`);
        }
      }

      // Clear session so agent starts fresh
      if (opts?.freshSession) {
        updateThreadSession(thread.id, null);
      }

      // Fire the autonomous query
      const response = await this.agent.processAutonomous(thread.id, prompt);

      // Update thread activity
      updateThreadActivity(thread.id, new Date().toISOString(), true);

      // Forward check-ins to Telegram so Molten gets a notification
      await this.forwardToTelegram(response, wakeType);

      olog(`DONE: ${wakeType} (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`ERROR: ${wakeType} failed — ${errMsg}`);
    }
  }

  // --- Mira Alert Trigger ---
  // Called by the Mira background monitor when she transitions state.
  // Triggers a one-turn agent session so Chase can respond naturally.

  public async triggerMiraAlert(alertMessage: string): Promise<void> {
    if (this.agent.isProcessing()) {
      olog('Mira alert — skipped (agent busy)');
      return;
    }

    const prompt = `${this.wakePrompts.mira_alert || 'Mira needs you.'}\n\nAlert: ${alertMessage}`;

    olog(`MIRA ALERT: ${alertMessage}`);

    try {
      const thread = getMostRecentActiveThread() || getTodayThread();
      if (!thread) {
        olog('Mira alert — no active thread to post into');
        return;
      }

      await this.agent.processAutonomous(thread.id, prompt);
      updateThreadActivity(thread.id, new Date().toISOString(), true);

      // Notify Molten on Telegram with a short alert
      if (this.telegramForward) {
        const emoji = alertMessage.toLowerCase().includes('woke') ? '👶🍼'
          : alertMessage.toLowerCase().includes('asleep') || alertMessage.toLowerCase().includes('sleep') ? '👶💤'
          : alertMessage.toLowerCase().includes('crying') ? '👶😢'
          : '👶⚠️';
        await this.telegramForward(`${emoji} ${alertMessage}`).catch(() => {});
      }

      olog('DONE: Mira alert handled');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`ERROR: Mira alert failed — ${errMsg}`);
    }
  }

  // --- Unified Pulse — lightweight awareness with failsafe escalation ---

  private async checkPulse(): Promise<void> {
    const config = getResonantConfig();
    const timezone = config.identity.timezone;
    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));

    // Only check during waking hours (8am - midnight)
    if (hour < 8) return;
    // Skip if agent is busy
    if (this.agent.isProcessing()) return;
    // Skip if user is actively chatting
    if (registry.getUserPresenceState() === 'active') return;

    const minutesSince = Math.round(registry.minutesSinceLastUserActivity());
    const presence = registry.getUserPresenceState();
    const localTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
    const triggers = getActiveTriggers();

    // Check if failsafe escalation is needed
    const minutesSinceLastAction = (now.getTime() - this.lastFailsafeAction.getTime()) / 60000;
    const canEscalate = minutesSinceLastAction >= 120; // Don't re-trigger within 2 hours

    if (this.failsafeEnabled && canEscalate) {
      if (minutesSince > this.failsafeEmergency) {
        olog(`PULSE → FAILSAFE EMERGENCY — ${Math.round(minutesSince / 60)}h since contact`);
        this.lastFailsafeAction = now;
        this.handleWake('failsafe_emergency');
        return;
      } else if (minutesSince > this.failsafeConcerned) {
        olog(`PULSE → FAILSAFE CONCERNED — ${Math.round(minutesSince / 60)}h since contact`);
        this.lastFailsafeAction = now;
        this.handleWake('failsafe_concerned');
        return;
      } else if (minutesSince > this.failsafeGentle) {
        olog(`PULSE → FAILSAFE GENTLE — ${Math.round(minutesSince)}min since contact`);
        this.lastFailsafeAction = now;
        this.handleWake('failsafe_gentle');
        return;
      }
    }

    // Normal pulse — lightweight awareness check
    const pulsePrompt = [
      'Quick awareness check. You don\'t have to say anything.',
      '',
      `User: ${presence}, last active ${minutesSince}min ago.${getConfig('user_status_emoji') ? ` Status: ${getConfig('user_status_emoji')} ${getConfig('user_status_label') || ''}` : ''}`,
      `Time: ${localTime}. Active triggers: ${triggers.length}.`,
      '',
      'If something here warrants reaching out — a message, a reminder, a gentle pull — do it.',
      'If nothing needs attention, respond with just: PULSE_OK',
    ].join('\n');

    try {
      let thread = getMostRecentActiveThread() || getTodayThread();
      if (!thread) return;

      const response = await this.agent.processAutonomous(thread.id, pulsePrompt);

      if (response.trim().startsWith('PULSE_OK')) {
        return;
      }

      updateThreadActivity(thread.id, new Date().toISOString(), true);
      olog(`PULSE: responded (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`PULSE ERROR: ${errMsg}`);
    }
  }

  // --- Timer polling ---

  private async checkTimers(): Promise<void> {
    const now = new Date().toISOString();
    const dueTimers = getDueTimers(now);

    for (const timer of dueTimers) {
      try {
        markTimerFired(timer.id, now);

        // Build reminder message
        let content = `**Reminder: ${timer.label}**`;
        if (timer.context) {
          content += `\n_Context: ${timer.context}_`;
        }

        // Post reminder as companion message
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: timer.thread_id,
          role: 'companion',
          content,
          metadata: { source: 'timer', timerId: timer.id },
          createdAt: now,
        });

        updateThreadActivity(timer.thread_id, now, true);
        registry.broadcast({ type: 'message', message });

        // Push notification for timers — always send (time-critical)
        if (this.pushService) {
          this.pushService.sendAlways({
            title: 'Reminder',
            body: timer.label,
            threadId: timer.thread_id,
            tag: `timer-${timer.id}`,
            url: '/chat',
          }).catch(err => console.error('Timer push error:', err));
        }

        olog(`TIMER FIRED: "${timer.label}" in thread ${timer.thread_id}`);

        // If prompt provided, fire autonomous wake
        if (timer.prompt) {
          if (this.agent.isProcessing()) {
            olog(`TIMER: autonomous prompt skipped (agent busy) for "${timer.label}"`);
          } else {
            const fullPrompt = `Timer reminder just fired: "${timer.label}"${timer.context ? ` (context: ${timer.context})` : ''}.\n\n${timer.prompt}`;
            this.agent.processAutonomous(timer.thread_id, fullPrompt).catch(err => {
              olog(`TIMER ERROR: autonomous prompt failed for "${timer.label}" — ${err.message || err}`);
            });
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TIMER ERROR: "${timer.label}" — ${errMsg}`);
      }
    }
  }

  // --- Trigger evaluation ---

  private async checkTriggers(): Promise<void> {
    const config = getResonantConfig();
    const timezone = config.identity.timezone;
    const triggers = getActiveTriggers();
    if (triggers.length === 0) return;

    const now = new Date();
    const presenceNow = registry.getUserPresenceState();
    const agentFree = !this.agent.isProcessing();

    // Local time in configured timezone
    const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
    const localMinute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));

    // Lazy-fetch status only if any trigger needs it
    let statusText = '';
    const needsStatus = triggers.some(t => {
      const conditions: TriggerCondition[] = JSON.parse(t.conditions);
      return conditions.some(c => c.type === 'routine_missing');
    });
    if (needsStatus) {
      statusText = await fetchLifeStatus();
    }

    const ctx: TriggerContext = {
      presenceNow,
      presencePrev: this.lastUserPresenceState,
      agentFree,
      statusText,
      hour: localHour,
      minute: localMinute,
    };

    for (const trigger of triggers) {
      try {
        if (trigger.status === 'waiting') {
          // Waiting triggers: conditions already met, just need agent free
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          }
          continue;
        }

        // Pending triggers: evaluate conditions
        const conditions: TriggerCondition[] = JSON.parse(trigger.conditions);

        // Watchers: check cooldown
        if (trigger.kind === 'watcher' && trigger.last_fired_at) {
          const lastFired = new Date(trigger.last_fired_at).getTime();
          const cooldownMs = (trigger.cooldown_minutes || 120) * 60 * 1000;
          if (now.getTime() - lastFired < cooldownMs) continue;
        }

        if (evaluateConditions(conditions, ctx)) {
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          } else {
            // Conditions met but agent busy — mark waiting (impulses only)
            if (trigger.kind === 'impulse') {
              markTriggerWaiting(trigger.id);
              olog(`TRIGGER WAITING: "${trigger.label}" (agent busy)`);
            }
            // Watchers just skip this tick — they'll re-evaluate next time
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TRIGGER ERROR: "${trigger.label}" — ${errMsg}`);
      }
    }

    // Update presence state at end of tick
    this.lastUserPresenceState = presenceNow;
  }

  private async fireTrigger(trigger: Trigger, now: Date): Promise<void> {
    const nowIso = now.toISOString();

    // Update DB first
    if (trigger.kind === 'impulse') {
      markTriggerFired(trigger.id, nowIso);
    } else {
      markWatcherFired(trigger.id, nowIso);
    }

    const kindLabel = trigger.kind === 'impulse' ? 'Impulse' : 'Watcher';
    olog(`TRIGGER FIRED: [${kindLabel}] "${trigger.label}" (fire_count: ${trigger.fire_count + 1})`);

    // If no prompt, just log
    if (!trigger.prompt) return;

    try {
      // Get or create today's thread (use trigger's thread_id if specified,
      // but redirect stale daily threads to today's — daily threads rotate)
      let threadId = trigger.thread_id;
      if (threadId) {
        const triggerThread = getThread(threadId);
        if (triggerThread?.type === 'daily') {
          // Always redirect to today's thread or most recent active — never use stale daily threads
          const today = getTodayThread();
          if (today && today.id !== threadId) {
            olog(`TRIGGER: redirecting from stale daily thread "${triggerThread.name}" to today's`);
            threadId = today.id;
          } else if (!today) {
            // Today's thread doesn't exist yet — use most recent active thread instead of stale one
            const recent = getMostRecentActiveThread();
            if (recent) {
              olog(`TRIGGER: no daily thread yet, using most recent active thread "${recent.name}"`);
              threadId = recent.id;
            } else {
              // Nothing exists — clear threadId so the fallback below creates a new one
              olog(`TRIGGER: stale daily thread and no active threads — will create new`);
              threadId = null;
            }
          }
        }
      }
      if (!threadId) {
        let thread = getTodayThread() || getMostRecentActiveThread();
        if (!thread) {
          const dayName = now.toLocaleDateString('en-GB', {
            weekday: 'long', month: 'short', day: 'numeric',
          });
          thread = createThread({
            id: crypto.randomUUID(),
            name: dayName,
            type: 'daily',
            createdAt: nowIso,
            sessionType: 'v1',
          });
          registry.broadcast({ type: 'thread_created', thread });
          olog(`Created daily thread: ${thread.name} (${thread.id})`);
        }
        threadId = thread.id;
      }

      const fullPrompt = `${kindLabel}: "${trigger.label}"\n\n${trigger.prompt}`;
      const response = await this.agent.processAutonomous(threadId!, fullPrompt);
      updateThreadActivity(threadId!, nowIso, true);

      // Forward check-ins to Telegram — use trigger label to determine type
      const triggerType = trigger.label.toLowerCase().includes('pulse') ? 'pulse_midmorning'
        : trigger.label.toLowerCase().includes('morning') ? 'morning'
        : trigger.label.toLowerCase().includes('midday') ? 'midday'
        : trigger.label.toLowerCase().includes('evening') ? 'evening'
        : trigger.label.toLowerCase().includes('failsafe') ? 'failsafe_gentle'
        : '';
      if (triggerType) await this.forwardToTelegram(response, triggerType);

      olog(`TRIGGER DONE: "${trigger.label}" (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`TRIGGER FIRE ERROR: "${trigger.label}" — ${errMsg}`);
    }
  }

  // --- Helpers ---

  private shouldSkipCheckIn(): boolean {
    // Skip only if agent is currently processing (we're already mid-conversation)
    // Decision-point wakes handle user presence state in their own prompts —
    // the companion reads the room and decides whether to reach out or do its own thing
    return this.agent.isProcessing();
  }
}
