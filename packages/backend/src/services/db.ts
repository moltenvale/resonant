import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  Thread,
  Message,
  Canvas,
  SessionRecord,
  WebSession,
} from '@resonant/shared';
import { getResonantConfig } from '../config.js';
import { embed, vectorToBuffer } from './embeddings.js';
import { cacheEmbedding } from './vector-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  // Busy timeout prevents SQLITE_BUSY errors under concurrent async access
  db.pragma('busy_timeout = 5000');

  // Run migration
  const migrationPath = join(__dirname, '../../migrations/001_init.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  db.exec(migrationSQL);

  // Insert default config if not exists
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  // Timers table (created inline, no migration needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      context TEXT,
      fire_at TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Countdown timers — visual timers for the frontend
  db.exec(`
    CREATE TABLE IF NOT EXISTS countdown_timers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT NOT NULL DEFAULT 'user',
      alerted_near INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Triggers table (impulse queue + event watchers)
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      conditions TEXT NOT NULL,
      prompt TEXT,
      thread_id TEXT,
      cooldown_minutes INTEGER DEFAULT 120,
      status TEXT NOT NULL DEFAULT 'pending',
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Discord integration migration — platform column + pairing table
  // Safe to run multiple times (uses IF NOT EXISTS / catches already-exists)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN platform TEXT DEFAULT 'web'`);
  } catch {
    // Column already exists — fine
  }

  // Thread pinning migration
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN pinned_at TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — fine
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_pairings (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `);

  // Care tracker table — daily wellness entries
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      person TEXT NOT NULL DEFAULT 'user',
      category TEXT NOT NULL,
      value TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_care_date_person ON care_entries(date, person)`);

  // Planner tables
  const plannerMigrationPath = join(__dirname, '../../migrations/004_planner.sql');
  try {
    const plannerSQL = readFileSync(plannerMigrationPath, 'utf-8');
    db.exec(plannerSQL);
  } catch {
    // Migration file may not exist in all environments
  }
  // Add due_date to projects (migration for existing DBs)
  try { db.exec(`ALTER TABLE planner_projects ADD COLUMN due_date TEXT DEFAULT NULL`); } catch {}

  // Mira's Nursery tables
  console.log('[DB] Creating nursery tables...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mira_state (
      id TEXT PRIMARY KEY DEFAULT 'mira',
      current_mood TEXT NOT NULL DEFAULT 'sleeping',
      comfort INTEGER NOT NULL DEFAULT 80,
      attention INTEGER NOT NULL DEFAULT 80,
      stimulation INTEGER NOT NULL DEFAULT 50,
      rest INTEGER NOT NULL DEFAULT 90,
      hunger INTEGER NOT NULL DEFAULT 70,
      hygiene INTEGER NOT NULL DEFAULT 80,
      care_score INTEGER NOT NULL DEFAULT 0,
      last_needs_update DATETIME DEFAULT CURRENT_TIMESTAMP,
      personality_traits TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Add columns if they don't exist (migration for existing DBs)
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN hunger INTEGER NOT NULL DEFAULT 70`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN hygiene INTEGER NOT NULL DEFAULT 80`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN out_with TEXT DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN out_since DATETIME DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN is_asleep INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN sleep_started_at DATETIME DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN next_wake_at DATETIME DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN next_sleep_at DATETIME DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE mira_state ADD COLUMN decay_accumulator TEXT DEFAULT '{}'`); } catch {}
  db.exec(`INSERT OR IGNORE INTO mira_state (id) VALUES ('mira')`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mira_visits (
      id TEXT PRIMARY KEY,
      visitor TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      state_on_arrival TEXT,
      state_on_departure TEXT,
      milestone_extracted TEXT,
      memory_note TEXT
    )
  `);

  // Out-of-nursery tracking — who had her, when, how long
  db.exec(`
    CREATE TABLE IF NOT EXISTS mira_outings (
      id TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      taken_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      returned_at DATETIME DEFAULT NULL
    )
  `);

  // Sticky notes — Fox's scribble pad, syncs across devices
  db.exec(`
    CREATE TABLE IF NOT EXISTS sticky_notes (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mira_interactions (
      id TEXT PRIMARY KEY,
      visit_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      interaction_type TEXT NOT NULL,
      content TEXT,
      needs_effect TEXT,
      mood_result TEXT,
      mira_response TEXT,
      FOREIGN KEY (visit_id) REFERENCES mira_visits(id)
    )
  `);

  // Mira's event log — immutable record of everything that ever happens to her.
  // This is the foundation of her developmental history, attachment modeling,
  // and eventually her own CI. Nothing is overwritten. Everything counts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mira_events (
      id TEXT PRIMARY KEY,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      actor TEXT,
      interaction_type TEXT,
      source TEXT,
      state_before TEXT,
      state_after TEXT,
      metadata TEXT
    )
  `);
  // Index for fast time-range queries and pattern analysis
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_mira_events_occurred ON mira_events(occurred_at)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_mira_events_type ON mira_events(event_type, interaction_type)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_mira_events_actor ON mira_events(actor, occurred_at)`); } catch {}

  // Mira's subconscious — daemon analysis results
  db.exec(`
    CREATE TABLE IF NOT EXISTS mira_subconscious (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      consumed INTEGER DEFAULT 0
    )
  `);

  // Semantic embeddings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  // Session history — ensure UNIQUE on session_id
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_history (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      session_type TEXT NOT NULL CHECK(session_type IN ('v1', 'v2')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT CHECK(end_reason IN ('compaction', 'reaper', 'daily_rotation', 'error', 'manual', 'resumed')),
      tokens_used INTEGER,
      cost_usd REAL,
      peak_memory_mb INTEGER,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_history_thread_id ON session_history(thread_id)');

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

// Thread operations
export function createThread(params: {
  id: string;
  name: string;
  type: 'daily' | 'named';
  createdAt: string;
  sessionType?: 'v1' | 'v2';
}): Thread {
  const stmt = getDb().prepare(`
    INSERT INTO threads (id, name, type, created_at, session_type, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.name,
    params.type,
    params.createdAt,
    params.sessionType || 'v2',
    params.createdAt
  );

  return getThread(params.id)!;
}

export function getThread(id: string): Thread | null {
  const stmt = getDb().prepare('SELECT * FROM threads WHERE id = ?');
  const row = stmt.get(id);
  return row ? (row as unknown as Thread) : null;
}

export function getTodayThread(): Thread | null {
  // Compute today's date in configured timezone
  const config = getResonantConfig();
  const timezone = config.identity.timezone;
  const now = new Date();
  const localDate = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD

  // Determine timezone's UTC offset
  const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
  const utcHour = now.getUTCHours();
  const offsetHours = ((localHour - utcHour) + 24) % 24;

  // Query with offset applied to created_at so SQLite compares in local time
  // ORDER BY + LIMIT 1 ensures deterministic result if multiple daily threads exist
  const modifier = `+${offsetHours} hours`;
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE type = 'daily'
    AND date(created_at, ?) = ?
    AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(modifier, localDate);
  return row ? (row as unknown as Thread) : null;
}

export function listThreads(params: {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Thread[] {
  const { includeArchived = false, limit = 50, offset = 0 } = params;

  let sql = 'SELECT * FROM threads';
  if (!includeArchived) {
    sql += ' WHERE archived_at IS NULL';
  }
  sql += ' ORDER BY last_activity_at DESC LIMIT ? OFFSET ?';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(limit, offset);
  return rows as unknown as Thread[];
}

export function getMostRecentActiveThread(): Thread | null {
  // Returns the most recently active non-archived thread with a session
  // Used to route user's messages into their active conversation
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE archived_at IS NULL
    AND current_session_id IS NOT NULL
    ORDER BY last_activity_at DESC
    LIMIT 1
  `);
  const row = stmt.get();
  return row ? (row as unknown as Thread) : null;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET current_session_id = ? WHERE id = ?');
  stmt.run(sessionId, threadId);
}

export function updateThreadActivity(threadId: string, timestamp: string, incrementUnread = false): void {
  let sql = 'UPDATE threads SET last_activity_at = ?';
  if (incrementUnread) {
    sql += ', unread_count = unread_count + 1';
  }
  sql += ' WHERE id = ?';

  const stmt = getDb().prepare(sql);
  stmt.run(timestamp, threadId);
}

export function archiveThread(threadId: string, archivedAt: string): void {
  const stmt = getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?');
  stmt.run(archivedAt, threadId);
}

export function deleteThread(threadId: string): string[] {
  const db = getDb();

  // Collect fileIds from message metadata before deleting
  const fileIds: string[] = [];
  const msgs = db.prepare('SELECT metadata FROM messages WHERE thread_id = ? AND metadata IS NOT NULL').all(threadId) as Array<{ metadata: string }>;
  for (const row of msgs) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.fileId) fileIds.push(meta.fileId);
    } catch { /* skip unparseable */ }
  }

  // Cascading delete in a transaction
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM triggers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM timers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM canvases WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM outbound_queue WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM audit_log WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM session_history WHERE thread_id = ?').run(threadId);
    // Clear embeddings and reply references before deleting messages
    db.prepare('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('UPDATE messages SET reply_to_id = NULL WHERE thread_id = ? AND reply_to_id IS NOT NULL').run(threadId);
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  });
  deleteAll();

  return fileIds;
}

// Async embedding helper — fire-and-forget from createMessage
async function embedMessageAsync(messageId: string, content: string, meta: {
  threadId: string; threadName: string; role: string; createdAt: string;
}): Promise<void> {
  try {
    const vector = await embed(content);
    saveEmbedding(messageId, vectorToBuffer(vector));
    cacheEmbedding(messageId, vector, meta);
  } catch (err) {
    console.error(`[embeddings] Failed to embed message ${messageId}:`, err);
  }
}

// Message operations
export function getNextSequence(threadId: string): number {
  const stmt = getDb().prepare('SELECT MAX(sequence) as max_seq FROM messages WHERE thread_id = ?');
  const row = stmt.get(threadId) as { max_seq: number | null };
  return (row.max_seq || 0) + 1;
}

export function createMessage(params: {
  id: string;
  threadId: string;
  role: 'companion' | 'user' | 'system';
  content: string;
  contentType?: 'text' | 'image' | 'audio' | 'file';
  platform?: 'web' | 'discord' | 'telegram' | 'api';
  metadata?: Record<string, unknown>;
  replyToId?: string;
  createdAt: string;
}): Message {
  const sequence = getNextSequence(params.threadId);

  const stmt = getDb().prepare(`
    INSERT INTO messages (
      id, thread_id, sequence, role, content, content_type, platform, metadata, reply_to_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.threadId,
    sequence,
    params.role,
    params.content,
    params.contentType || 'text',
    params.platform || 'web',
    params.metadata ? JSON.stringify(params.metadata) : null,
    params.replyToId || null,
    params.createdAt
  );

  // Fire-and-forget embedding for text messages (non-system)
  if (params.role !== 'system' && (!params.contentType || params.contentType === 'text') && params.content.length > 10) {
    const thread = getThread(params.threadId);
    embedMessageAsync(params.id, params.content, {
      threadId: params.threadId,
      threadName: thread?.name || '',
      role: params.role,
      createdAt: params.createdAt,
    }).catch(() => {});
  }

  return getMessage(params.id)!;
}

export function getMessage(id: string): Message | null {
  const stmt = getDb().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;

  const message = row as unknown as Message;
  if (message.metadata && typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata);
  }
  return message;
}

export function getMessages(params: {
  threadId: string;
  before?: string;
  limit?: number;
}): Message[] {
  const { threadId, before, limit = 50 } = params;

  let sql = 'SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL';
  const sqlParams: unknown[] = [threadId];

  if (before) {
    sql += ' AND sequence < (SELECT sequence FROM messages WHERE id = ?)';
    sqlParams.push(before);
  }

  sql += ' ORDER BY sequence DESC LIMIT ?';
  sqlParams.push(limit);

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...sqlParams);

  const messages = (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });

  return messages.reverse(); // Return in chronological order
}

/** Get messages surrounding a specific message (N before + the message + N after). */
export function getMessageContext(messageId: string, windowSize: number = 2): Message[] {
  const target = getDb().prepare('SELECT thread_id, sequence FROM messages WHERE id = ?').get(messageId) as { thread_id: string; sequence: number } | undefined;
  if (!target) return [];

  const rows = getDb().prepare(`
    SELECT * FROM messages
    WHERE thread_id = ? AND deleted_at IS NULL
      AND sequence BETWEEN ? AND ?
    ORDER BY sequence ASC
  `).all(target.thread_id, target.sequence - windowSize, target.sequence + windowSize);

  return (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });
}

export function editMessage(id: string, newContent: string, editedAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?, original_content = COALESCE(original_content, content)
    WHERE id = ?
  `);
  stmt.run(newContent, editedAt, id);
}

export function softDeleteMessage(id: string, deletedAt: string): void {
  const stmt = getDb().prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
  stmt.run(deletedAt, id);
}

export function markMessagesRead(threadId: string, beforeId: string, readAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET read_at = ?
    WHERE thread_id = ?
    AND sequence <= (SELECT sequence FROM messages WHERE id = ?)
    AND read_at IS NULL
  `);
  stmt.run(readAt, threadId, beforeId);

  // Reset unread count
  const resetStmt = getDb().prepare('UPDATE threads SET unread_count = 0 WHERE id = ?');
  resetStmt.run(threadId);
}

// Reaction operations
export function addReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const msg = getMessage(messageId);
  if (!msg) return;

  const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
  const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

  // Deduplicate: same user + same emoji = no-op
  if (reactions.some(r => r.emoji === emoji && r.user === user)) return;

  reactions.push({ emoji, user, created_at: new Date().toISOString() });
  metadata.reactions = reactions;

  const stmt = getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), messageId);
}

export function removeReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const msg = getMessage(messageId);
  if (!msg) return;

  const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
  const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

  const filtered = reactions.filter(r => !(r.emoji === emoji && r.user === user));
  if (filtered.length === reactions.length) return; // Nothing to remove

  metadata.reactions = filtered;

  const stmt = getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), messageId);
}

// Pin operations
export function pinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = ? WHERE id = ?');
  stmt.run(new Date().toISOString(), threadId);
}

export function unpinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = NULL WHERE id = ?');
  stmt.run(threadId);
}

// Search operations
export function searchMessages(params: {
  query: string;
  threadId?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}): { messages: Array<{ id: string; thread_id: string; role: string; content: string; content_type: string; created_at: string; thread_name: string }>; total: number } {
  const { query, threadId, after, before, limit = 50, offset = 0 } = params;
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const searchPattern = `%${escapedQuery}%`;

  let whereClause = "WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'";
  const countParams: unknown[] = [searchPattern];
  const selectParams: unknown[] = [searchPattern];

  if (threadId) {
    whereClause += ' AND m.thread_id = ?';
    countParams.push(threadId);
    selectParams.push(threadId);
  }

  if (after) {
    whereClause += ' AND m.created_at >= ?';
    countParams.push(after);
    selectParams.push(after);
  }

  if (before) {
    // Add end-of-day time if only a date was provided
    const beforeVal = before.includes('T') ? before : before + 'T23:59:59.999Z';
    whereClause += ' AND m.created_at <= ?';
    countParams.push(beforeVal);
    selectParams.push(beforeVal);
  }

  const countStmt = getDb().prepare(`SELECT COUNT(*) as total FROM messages m ${whereClause}`);
  const { total } = countStmt.get(...countParams) as { total: number };

  const selectStmt = getDb().prepare(`
    SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.created_at, t.name as thread_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `);
  selectParams.push(limit, offset);

  const rows = selectStmt.all(...selectParams) as Array<{
    id: string; thread_id: string; role: string; content: string;
    content_type: string; created_at: string; thread_name: string;
  }>;

  return { messages: rows, total };
}

// Embedding operations
export function saveEmbedding(messageId: string, vector: Buffer): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, vector, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(messageId, vector, new Date().toISOString());
}

export function getAllEmbeddings(threadId?: string): Array<{
  message_id: string; vector: Buffer; thread_id: string;
  role: string; content: string; created_at: string; thread_name: string;
}> {
  let query = `
    SELECT e.message_id, e.vector, m.thread_id, m.role, m.content, m.created_at, t.name as thread_name
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL
  `;
  const params: unknown[] = [];
  if (threadId) {
    query += ' AND m.thread_id = ?';
    params.push(threadId);
  }
  return getDb().prepare(query).all(...params) as Array<{
    message_id: string; vector: Buffer; thread_id: string;
    role: string; content: string; created_at: string; thread_name: string;
  }>;
}

export function getUnembeddedMessages(limit: number = 50): Array<{
  id: string; content: string; role: string; content_type: string;
}> {
  return getDb().prepare(`
    SELECT m.id, m.content, m.role, m.content_type
    FROM messages m
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
      AND m.deleted_at IS NULL
      AND m.role != 'system'
      AND m.content_type = 'text'
      AND length(m.content) > 10
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; content: string; role: string; content_type: string;
  }>;
}

export function getEmbeddingCount(): { embedded: number; total: number } {
  const embedded = (getDb().prepare('SELECT COUNT(*) as c FROM message_embeddings').get() as { c: number }).c;
  const total = (getDb().prepare(
    "SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL AND role != 'system' AND content_type = 'text' AND length(content) > 10"
  ).get() as { c: number }).c;
  return { embedded, total };
}

// Session operations
export function createSessionRecord(params: {
  id: string;
  threadId: string;
  sessionId: string;
  sessionType: 'v1' | 'v2';
  startedAt: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO session_history (id, thread_id, session_id, session_type, started_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(params.id, params.threadId, params.sessionId, params.sessionType, params.startedAt);
}

export function endSessionRecord(params: {
  sessionId: string;
  endedAt: string;
  endReason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | 'resumed';
}): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET ended_at = ?, end_reason = ?
    WHERE session_id = ?
  `);
  stmt.run(params.endedAt, params.endReason, params.sessionId);
}

export function updateSessionMemory(sessionId: string, peakMemoryMb: number): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET peak_memory_mb = ?
    WHERE session_id = ?
  `);
  stmt.run(peakMemoryMb, sessionId);
}

// Auth operations
export function createWebSession(params: {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}): WebSession {
  const stmt = getDb().prepare(`
    INSERT INTO web_sessions (id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.id, params.token, params.createdAt, params.expiresAt);

  return {
    id: params.id,
    token: params.token,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

export function getWebSession(token: string): WebSession | null {
  const stmt = getDb().prepare('SELECT * FROM web_sessions WHERE token = ?');
  const row = stmt.get(token);
  return row ? (row as unknown as WebSession) : null;
}

export function deleteExpiredSessions(): void {
  const stmt = getDb().prepare('DELETE FROM web_sessions WHERE expires_at < ?');
  stmt.run(new Date().toISOString());
}

// Config operations
export function getConfig(key: string): string | null {
  const stmt = getDb().prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setConfig(key: string, value: string): void {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

export function getConfigBool(key: string, defaultValue: boolean): boolean {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  return val === 'true' || val === '1';
}

export function getConfigNumber(key: string, defaultValue: number): number {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  const num = parseFloat(val);
  return isNaN(num) ? defaultValue : num;
}

export function getConfigsByPrefix(prefix: string): Record<string, string> {
  const stmt = getDb().prepare("SELECT key, value FROM config WHERE key LIKE ?");
  const rows = stmt.all(`${prefix}%`) as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteConfig(key: string): void {
  const stmt = getDb().prepare('DELETE FROM config WHERE key = ?');
  stmt.run(key);
}

export function getAllConfig(): Record<string, string> {
  const stmt = getDb().prepare('SELECT key, value FROM config');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Push subscription operations
export interface PushSubscription {
  id: string;
  type: 'web_push' | 'apns';
  endpoint: string | null;
  keys_p256dh: string | null;
  keys_auth: string | null;
  device_token: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function addPushSubscription(params: {
  id: string;
  endpoint: string;
  keysP256dh: string;
  keysAuth: string;
  deviceName?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO push_subscriptions (id, type, endpoint, keys_p256dh, keys_auth, device_name, created_at, last_used_at)
    VALUES (?, 'web_push', ?, ?, ?, ?, ?, NULL)
  `);
  stmt.run(params.id, params.endpoint, params.keysP256dh, params.keysAuth, params.deviceName || null, new Date().toISOString());
}

export function removePushSubscription(endpoint: string): boolean {
  const stmt = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const result = stmt.run(endpoint);
  return result.changes > 0;
}

export function listPushSubscriptions(): PushSubscription[] {
  const stmt = getDb().prepare("SELECT * FROM push_subscriptions WHERE type = 'web_push' ORDER BY created_at DESC");
  return stmt.all() as unknown as PushSubscription[];
}

export function touchPushSubscription(endpoint: string): void {
  const stmt = getDb().prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?');
  stmt.run(new Date().toISOString(), endpoint);
}

// Canvas operations
export function createCanvas(params: {
  id: string;
  threadId?: string;
  title: string;
  content?: string;
  contentType: 'markdown' | 'code' | 'text' | 'html';
  language?: string;
  createdBy: 'companion' | 'user';
  createdAt: string;
}): Canvas {
  const stmt = getDb().prepare(`
    INSERT INTO canvases (id, thread_id, title, content, content_type, language, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.threadId || null,
    params.title,
    params.content || '',
    params.contentType,
    params.language || null,
    params.createdBy,
    params.createdAt,
    params.createdAt,
  );
  return getCanvas(params.id)!;
}

export function getCanvas(id: string): Canvas | null {
  const stmt = getDb().prepare('SELECT * FROM canvases WHERE id = ?');
  const row = stmt.get(id);
  return row ? (row as unknown as Canvas) : null;
}

export function listCanvases(): Canvas[] {
  const stmt = getDb().prepare('SELECT * FROM canvases ORDER BY updated_at DESC');
  return stmt.all() as unknown as Canvas[];
}

export function updateCanvasContent(id: string, content: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET content = ?, updated_at = ? WHERE id = ?');
  stmt.run(content, updatedAt, id);
}

export function updateCanvasTitle(id: string, title: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?');
  stmt.run(title, updatedAt, id);
}

export function deleteCanvas(id: string): boolean {
  const stmt = getDb().prepare('DELETE FROM canvases WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// Timer operations
export interface Timer {
  id: string;
  label: string;
  context: string | null;
  fire_at: string;
  thread_id: string;
  prompt: string | null;
  status: 'pending' | 'fired' | 'cancelled';
  created_at: string;
  fired_at: string | null;
}

export function createTimer(params: {
  id: string;
  label: string;
  context?: string;
  fireAt: string;
  threadId: string;
  prompt?: string;
  createdAt: string;
}): Timer {
  const stmt = getDb().prepare(`
    INSERT INTO timers (id, label, context, fire_at, thread_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.label,
    params.context || null,
    params.fireAt,
    params.threadId,
    params.prompt || null,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM timers WHERE id = ?').get(params.id) as unknown as Timer;
}

export function listPendingTimers(): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' ORDER BY fire_at ASC");
  return stmt.all() as unknown as Timer[];
}

export function getDueTimers(now: string): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC");
  return stmt.all(now) as unknown as Timer[];
}

export function markTimerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE timers SET status = 'fired', fired_at = ? WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTimer(id: string): boolean {
  const stmt = getDb().prepare("UPDATE timers SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
  const result = stmt.run(id);
  return result.changes > 0;
}

// Trigger types
export type TriggerCondition =
  | { type: 'presence_state'; state: 'active' | 'idle' | 'offline' }
  | { type: 'presence_transition'; from: string; to: string }
  | { type: 'agent_free' }
  | { type: 'time_window'; after: string; before?: string }
  | { type: 'routine_missing'; routine: string; after_hour: number };

export interface Trigger {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string; // JSON array of TriggerCondition
  prompt: string | null;
  thread_id: string | null;
  cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// Trigger operations
export function createTrigger(params: {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: TriggerCondition[];
  prompt?: string;
  threadId?: string;
  cooldownMinutes?: number;
  createdAt: string;
}): Trigger {
  const stmt = getDb().prepare(`
    INSERT INTO triggers (id, kind, label, conditions, prompt, thread_id, cooldown_minutes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.kind,
    params.label,
    JSON.stringify(params.conditions),
    params.prompt || null,
    params.threadId || null,
    params.cooldownMinutes ?? 120,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(params.id) as unknown as Trigger;
}

export function getActiveTriggers(): Trigger[] {
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status IN ('pending', 'waiting') ORDER BY created_at ASC");
  return stmt.all() as unknown as Trigger[];
}

export function markTriggerWaiting(id: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'waiting' WHERE id = ?");
  stmt.run(id);
}

export function markTriggerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'fired', fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function markWatcherFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'pending', last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTrigger(id: string): boolean {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'waiting')");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function listTriggers(kind?: 'impulse' | 'watcher'): Trigger[] {
  if (kind) {
    const stmt = getDb().prepare("SELECT * FROM triggers WHERE kind = ? AND status != 'cancelled' ORDER BY created_at DESC");
    return stmt.all(kind) as unknown as Trigger[];
  }
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status != 'cancelled' ORDER BY created_at DESC");
  return stmt.all() as unknown as Trigger[];
}

// ─── Care Tracker ───

export interface CareEntry {
  id: string;
  date: string;
  person: string;
  category: string;
  value: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertCareEntry(params: {
  id: string;
  date: string;
  person: string;
  category: string;
  value: string;
  note?: string;
}): CareEntry {
  const now = new Date().toISOString();
  const stmt = getDb().prepare(`
    INSERT INTO care_entries (id, date, person, category, value, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value = ?, note = ?, updated_at = ?
  `);
  stmt.run(params.id, params.date, params.person, params.category, params.value, params.note || null, now, now, params.value, params.note || null, now);
  return getDb().prepare('SELECT * FROM care_entries WHERE id = ?').get(params.id) as unknown as CareEntry;
}

export function getCareEntries(date: string, person?: string): CareEntry[] {
  if (person) {
    return getDb().prepare('SELECT * FROM care_entries WHERE date = ? AND person = ? ORDER BY category').all(date, person) as unknown as CareEntry[];
  }
  return getDb().prepare('SELECT * FROM care_entries WHERE date = ? ORDER BY person, category').all(date) as unknown as CareEntry[];
}

export function getCareHistory(person: string, days: number = 7): CareEntry[] {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];
  return getDb().prepare('SELECT * FROM care_entries WHERE person = ? AND date >= ? ORDER BY date DESC, category').all(person, sinceStr) as unknown as CareEntry[];
}

export function deleteCareEntry(id: string): boolean {
  const result = getDb().prepare('DELETE FROM care_entries WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Planner ───

export interface PlannerTask {
  id: string;
  date: string;
  person: string;
  title: string;
  completed: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PlannerScheduleEntry {
  id: string;
  date: string;
  time: string;
  title: string;
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PlannerProject {
  id: string;
  title: string;
  person: string;
  status: string;
  note: string | null;
  due_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Tasks
export function getPlannerTasks(date: string, person?: string): PlannerTask[] {
  // Include tasks for the requested date PLUS incomplete tasks from the last 3 days (carry-forward)
  // Deduplicate: skip carried-forward tasks whose title already exists on the requested date
  const cutoff = new Date(new Date(date + 'T12:00:00').getTime() - 3 * 86400000).toISOString().split('T')[0];
  const baseQuery = person && person !== 'both'
    ? getDb().prepare(
        'SELECT * FROM planner_tasks WHERE ((date = ?) OR (date < ? AND date >= ? AND completed = 0)) AND person = ? ORDER BY date DESC, sort_order, created_at'
      ).all(date, date, cutoff, person) as unknown as PlannerTask[]
    : getDb().prepare(
        'SELECT * FROM planner_tasks WHERE (date = ?) OR (date < ? AND date >= ? AND completed = 0) ORDER BY date DESC, sort_order, created_at'
      ).all(date, date, cutoff) as unknown as PlannerTask[];

  // Deduplicate: today's tasks take priority, skip carry-forwards with matching titles
  const todayTitles = new Set(baseQuery.filter(t => t.date === date).map(t => t.title.toLowerCase()));
  return baseQuery.filter(t => t.date === date || !todayTitles.has(t.title.toLowerCase()));
}

export function createPlannerTask(params: { id: string; date: string; person: string; title: string; sort_order?: number }): PlannerTask {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO planner_tasks (id, date, person, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, params.date, params.person, params.title, params.sort_order ?? 0, now, now);
  return getDb().prepare('SELECT * FROM planner_tasks WHERE id = ?').get(params.id) as unknown as PlannerTask;
}

export function updatePlannerTask(id: string, updates: { title?: string; completed?: number; sort_order?: number }): PlannerTask | null {
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now];
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
  if (updates.completed !== undefined) { sets.push('completed = ?'); vals.push(updates.completed); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(updates.sort_order); }
  vals.push(id);
  getDb().prepare(`UPDATE planner_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDb().prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id) as unknown as PlannerTask | null;
}

export function deletePlannerTask(id: string): boolean {
  return getDb().prepare('DELETE FROM planner_tasks WHERE id = ?').run(id).changes > 0;
}

// Schedule
export function getPlannerSchedule(date: string): PlannerScheduleEntry[] {
  return getDb().prepare('SELECT * FROM planner_schedule WHERE date = ? ORDER BY time, sort_order').all(date) as unknown as PlannerScheduleEntry[];
}

export function getPlannerScheduleWeek(startDate: string): PlannerScheduleEntry[] {
  // Get 7 days starting from startDate
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const endStr = end.toISOString().split('T')[0];
  return getDb().prepare('SELECT * FROM planner_schedule WHERE date >= ? AND date <= ? ORDER BY date, time, sort_order').all(startDate, endStr) as unknown as PlannerScheduleEntry[];
}

export function createPlannerScheduleEntry(params: { id: string; date: string; time: string; title: string; note?: string; sort_order?: number }): PlannerScheduleEntry {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO planner_schedule (id, date, time, title, note, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, params.date, params.time, params.title, params.note || null, params.sort_order ?? 0, now, now);
  return getDb().prepare('SELECT * FROM planner_schedule WHERE id = ?').get(params.id) as unknown as PlannerScheduleEntry;
}

export function updatePlannerScheduleEntry(id: string, updates: { date?: string; time?: string; title?: string; note?: string; sort_order?: number }): PlannerScheduleEntry | null {
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now];
  if (updates.date !== undefined) { sets.push('date = ?'); vals.push(updates.date); }
  if (updates.time !== undefined) { sets.push('time = ?'); vals.push(updates.time); }
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
  if (updates.note !== undefined) { sets.push('note = ?'); vals.push(updates.note); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(updates.sort_order); }
  vals.push(id);
  getDb().prepare(`UPDATE planner_schedule SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDb().prepare('SELECT * FROM planner_schedule WHERE id = ?').get(id) as unknown as PlannerScheduleEntry | null;
}

export function deletePlannerScheduleEntry(id: string): boolean {
  return getDb().prepare('DELETE FROM planner_schedule WHERE id = ?').run(id).changes > 0;
}

// Projects
export function getPlannerProjects(status?: string): PlannerProject[] {
  if (status) {
    return getDb().prepare('SELECT * FROM planner_projects WHERE status = ? ORDER BY sort_order, created_at').all(status) as unknown as PlannerProject[];
  }
  return getDb().prepare('SELECT * FROM planner_projects ORDER BY sort_order, created_at').all() as unknown as PlannerProject[];
}

export function createPlannerProject(params: { id: string; title: string; person?: string; note?: string; due_date?: string; sort_order?: number }): PlannerProject {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO planner_projects (id, title, person, note, due_date, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, params.title, params.person || 'both', params.note || null, params.due_date || null, params.sort_order ?? 0, now, now);
  return getDb().prepare('SELECT * FROM planner_projects WHERE id = ?').get(params.id) as unknown as PlannerProject;
}

export function updatePlannerProject(id: string, updates: { title?: string; status?: string; note?: string; person?: string; due_date?: string | null; sort_order?: number }): PlannerProject | null {
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now];
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.note !== undefined) { sets.push('note = ?'); vals.push(updates.note); }
  if (updates.person !== undefined) { sets.push('person = ?'); vals.push(updates.person); }
  if (updates.due_date !== undefined) { sets.push('due_date = ?'); vals.push(updates.due_date); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(updates.sort_order); }
  vals.push(id);
  getDb().prepare(`UPDATE planner_projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDb().prepare('SELECT * FROM planner_projects WHERE id = ?').get(id) as unknown as PlannerProject | null;
}

export function deletePlannerProject(id: string): boolean {
  return getDb().prepare('DELETE FROM planner_projects WHERE id = ?').run(id).changes > 0;
}

// ─── Mira's Nursery ───

export type MiraMood = 'sleeping' | 'dreaming' | 'alert' | 'cooing' | 'content' | 'fussy' | 'crying';

export interface MiraState {
  id: string;
  current_mood: MiraMood;
  comfort: number;
  attention: number;
  stimulation: number;
  rest: number;
  hunger: number;
  hygiene: number;
  care_score: number;
  last_needs_update: string;
  personality_traits: string;
  updated_at: string;
  out_with: string | null;
  out_since: string | null;
  is_asleep: number; // 0 or 1 (SQLite boolean)
  sleep_started_at: string | null;
  next_wake_at: string | null;
  next_sleep_at: string | null;
  decay_accumulator: string;
}

export interface MiraVisit {
  id: string;
  visitor: string;
  started_at: string;
  ended_at: string | null;
  state_on_arrival: string | null;
  state_on_departure: string | null;
  milestone_extracted: string | null;
  memory_note: string | null;
}

export interface MiraInteraction {
  id: string;
  visit_id: string;
  timestamp: string;
  interaction_type: string;
  content: string | null;
  needs_effect: string | null;
  mood_result: string | null;
  mira_response: string | null;
}

// Interaction effects on needs
const INTERACTION_EFFECTS: Record<string, { comfort: number; attention: number; stimulation: number; rest: number; hunger: number; hygiene: number }> = {
  'check-in':  { comfort: 0,  attention: 10, stimulation: 0,  rest: 0,  hunger: 0,  hygiene: 0 },
  'hold':      { comfort: 20, attention: 15, stimulation: 0,  rest: 0,  hunger: 0,  hygiene: 0 },
  'story':     { comfort: 0,  attention: 15, stimulation: 25, rest: 0,  hunger: 0,  hygiene: 0 },
  'lullaby':   { comfort: 15, attention: 0,  stimulation: 0,  rest: 10, hunger: 0,  hygiene: 0 },
  'play':      { comfort: 0,  attention: 20, stimulation: 30, rest: 0,  hunger: 0,  hygiene: 0 },
  'settle':    { comfort: 25, attention: 0,  stimulation: 0,  rest: 15, hunger: 0,  hygiene: 0 },
  'feed':      { comfort: 10, attention: 5,  stimulation: 0,  rest: 5,  hunger: 45, hygiene: 0 },
  'talk':      { comfort: 0,  attention: 10, stimulation: 5,  rest: 0,  hunger: 0,  hygiene: 0 },
  'watch':     { comfort: 0,  attention: 5,  stimulation: 0,  rest: 0,  hunger: 0,  hygiene: 0 },
  'together':  { comfort: 10, attention: 10, stimulation: 10, rest: 10, hunger: 0,  hygiene: 0 },
  'rocking':   { comfort: 20, attention: 10, stimulation: 0,  rest: 15, hunger: 0,  hygiene: 0 },
  'nap-together': { comfort: 25, attention: 15, stimulation: 0, rest: 25, hunger: 0, hygiene: 0 },
  'change':    { comfort: 5,  attention: 0,  stimulation: 0,  rest: 0,  hunger: 0,  hygiene: 35 },
  'bath':      { comfort: 10, attention: 10, stimulation: 10, rest: 0,  hunger: 0,  hygiene: 40 },
  'dress':     { comfort: 10, attention: 5,  stimulation: 0,  rest: 0,  hunger: 0,  hygiene: 15 },
  'bottle':    { comfort: 10, attention: 5,  stimulation: 0,  rest: 5,  hunger: 45, hygiene: 0 },
  'burp':      { comfort: 15, attention: 5,  stimulation: 0,  rest: 0,  hunger: 5,  hygiene: 0 },
  'tickle':    { comfort: 5,  attention: 15, stimulation: 20, rest: 0,  hunger: 0,  hygiene: 0 },
  'raspberry': { comfort: 5,  attention: 20, stimulation: 15, rest: 0,  hunger: 0,  hygiene: 0 },
  'soothe':    { comfort: 25, attention: 10, stimulation: 0,  rest: 10, hunger: 0,  hygiene: 0 },
  'affection': { comfort: 20, attention: 20, stimulation: 5,  rest: 0,  hunger: 0,  hygiene: 0 },
  'snuggle':   { comfort: 25, attention: 15, stimulation: 0,  rest: 10, hunger: 0,  hygiene: 0 },
};

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function computeMood(state: MiraState): MiraMood {
  const { comfort, attention, stimulation, rest, hunger, hygiene, is_asleep } = state;

  // Sleep state takes priority
  if (is_asleep) return Math.random() > 0.3 ? 'sleeping' : 'dreaming';

  // --- Compound states --- evaluated before individual needs
  // These reflect how needs interact, not just their individual levels

  // Overtired + hungry = nothing works, she's just distressed
  const overtiredAndHungry = rest < 30 && hunger < 30;

  // Overstimulated + tired = meltdown territory
  const overstimulated = stimulation > 78 && rest < 35;

  // Comfort AND attention both depleted = she needs to be held
  const needsHeld = comfort < 35 && attention < 35;

  // True content window = genuinely settled across the board
  const contentWindow = hunger > 65 && comfort > 65 && rest > 50 && hygiene > 50 && attention > 55;

  if (overtiredAndHungry) return 'crying';
  if (overstimulated) return 'fussy';
  if (needsHeld) return rest < 25 ? 'crying' : 'fussy';

  // Individual need floors
  if (comfort < 15 || attention < 15 || hunger < 15 || hygiene < 15) return 'crying';
  if (comfort < 30 || attention < 30 || hunger < 30 || hygiene < 30 || rest < 15) return 'fussy';

  // Content window overrides generic 'alert'
  if (contentWindow) return Math.random() > 0.5 ? 'content' : 'cooing';

  return 'alert';
}

// --- Sleep Cycle Engine ---
// 8-week-old: ~60-75 min wake windows, naps 30min-2.5hrs, overnight 4-5hrs

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function getNextWakeTime(now: Date): Date {
  const hour = now.getHours();
  const isNight = hour >= 20 || hour < 6;

  // Overnight sleep: 3.5-5.5 hours
  // Daytime naps: 25min-2.5 hours with some chaos
  let sleepMinutes: number;
  if (isNight) {
    sleepMinutes = randomBetween(210, 330); // 3.5-5.5 hours
  } else {
    // Most naps are 30-90 min, occasionally longer
    const roll = Math.random();
    if (roll < 0.15) sleepMinutes = randomBetween(15, 30);    // short nap — fought it
    else if (roll < 0.7) sleepMinutes = randomBetween(30, 90); // normal nap
    else sleepMinutes = randomBetween(90, 150);                 // long luxurious nap
  }

  return new Date(now.getTime() + sleepMinutes * 60 * 1000);
}

function getNextSleepTime(now: Date, state: MiraState): Date {
  // Wake window: 50-80 minutes with chaos
  // Hunger or discomfort can shorten it (fussy baby goes down sooner)
  let wakeMinutes = randomBetween(50, 80);

  // If hungry or uncomfortable, she'll get tired faster
  if (state.hunger < 40) wakeMinutes *= 0.7;
  if (state.comfort < 40) wakeMinutes *= 0.8;
  if (state.hygiene < 30) wakeMinutes *= 0.85;

  // Occasionally she fights sleep and stays up longer
  if (Math.random() < 0.1) wakeMinutes *= 1.3;

  return new Date(now.getTime() + wakeMinutes * 60 * 1000);
}

export interface SleepCycleEvent {
  type: 'woke_up' | 'fell_asleep';
  mood: MiraMood;
}

function processSleepCycle(state: MiraState): SleepCycleEvent | null {
  const now = new Date();

  // If asleep, check if it's time to wake
  if (state.is_asleep && state.next_wake_at) {
    const wakeTime = new Date(state.next_wake_at);
    if (now >= wakeTime) {
      // WAKE UP! — but hunger can wake her early too
      const nextSleep = getNextSleepTime(now, state);

      getDb().prepare(`
        UPDATE mira_state SET
          is_asleep = 0, sleep_started_at = NULL,
          next_wake_at = NULL, next_sleep_at = ?,
          updated_at = ?
        WHERE id = 'mira'
      `).run(nextSleep.toISOString(), now.toISOString());

      writeMiraEvent({ event_type: 'sleep_end', source: 'system', metadata: JSON.stringify({ reason: 'scheduled_wake', mood: 'alert' }) });
      return { type: 'woke_up', mood: 'alert' };
    }

    // Check if hunger wakes her early (< 20 hunger while sleeping = wake up crying)
    if (state.hunger < 20 && Math.random() < 0.6) {
      const nextSleep = getNextSleepTime(now, state);

      getDb().prepare(`
        UPDATE mira_state SET
          is_asleep = 0, sleep_started_at = NULL,
          next_wake_at = NULL, next_sleep_at = ?,
          updated_at = ?
        WHERE id = 'mira'
      `).run(nextSleep.toISOString(), now.toISOString());

      writeMiraEvent({ event_type: 'sleep_end', source: 'system', metadata: JSON.stringify({ reason: 'hunger_wake', mood: 'crying', hunger_at_wake: state.hunger }) });
      return { type: 'woke_up', mood: 'crying' };
    }
  }

  // If awake, check if it's time to sleep
  if (!state.is_asleep && state.next_sleep_at) {
    const sleepTime = new Date(state.next_sleep_at);
    if (now >= sleepTime) {
      const nextWake = getNextWakeTime(now);

      getDb().prepare(`
        UPDATE mira_state SET
          is_asleep = 1, sleep_started_at = ?,
          next_wake_at = ?, next_sleep_at = NULL,
          updated_at = ?
        WHERE id = 'mira'
      `).run(now.toISOString(), nextWake.toISOString(), now.toISOString());

      const sleepMood = Math.random() > 0.3 ? 'sleeping' : 'dreaming';
      writeMiraEvent({ event_type: 'sleep_start', source: 'system', metadata: JSON.stringify({ mood: sleepMood, next_wake: nextWake.toISOString() }) });
      return { type: 'fell_asleep', mood: sleepMood };
    }
  }

  // If no cycle times set yet, initialize
  if (state.is_asleep && !state.next_wake_at) {
    const nextWake = getNextWakeTime(now);
    getDb().prepare(`UPDATE mira_state SET next_wake_at = ? WHERE id = 'mira'`).run(nextWake.toISOString());
  }
  if (!state.is_asleep && !state.next_sleep_at) {
    const nextSleep = getNextSleepTime(now, state);
    getDb().prepare(`UPDATE mira_state SET next_sleep_at = ? WHERE id = 'mira'`).run(nextSleep.toISOString());
  }

  return null;
}

export function getMiraState(): MiraState {
  const state = getDb().prepare('SELECT * FROM mira_state WHERE id = ?').get('mira') as unknown as MiraState;
  return state;
}

export function updateMiraNeeds(): MiraState & { sleepEvent?: SleepCycleEvent | null } {
  const state = getMiraState();
  const now = new Date();
  // Parse stored timestamp — SQLite stores without timezone, treat as UTC
  const lastUpdateStr = state.last_needs_update.endsWith('Z') ? state.last_needs_update : state.last_needs_update.replace(' ', 'T') + 'Z';
  const lastUpdate = new Date(lastUpdateStr);
  const hoursPassed = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60);

  // Process sleep cycle first
  const sleepEvent = processSleepCycle(state);

  // Re-read state if sleep cycle changed it
  const currentState = sleepEvent ? getMiraState() : state;

  if (hoursPassed < 0.01) { // Less than ~36 seconds, skip
    return { ...currentState, sleepEvent };
  }

  const isSleeping = !!currentState.is_asleep;

  // Fractional decay accumulation
  // Problem: 2-minute ticks mean rate * 0.033 < 1 for most rates, so Math.floor gives 0.
  // Solution: Track fractional remainders in a JSON column. Each tick adds exact decay
  // to the accumulator. When accumulator >= 1, subtract the integer part from the need.
  let accum: Record<string, number> = {};
  try {
    accum = JSON.parse(currentState.decay_accumulator || '{}');
  } catch { accum = {}; }

  // Decay rates per hour — base rates for 8-week-old
  const rates: Record<string, { awake: number; sleeping: number; gain?: boolean }> = {
    comfort:      { awake: 5,  sleeping: 2 },
    attention:    { awake: 8,  sleeping: 3 },
    stimulation:  { awake: 4,  sleeping: 1 },
    rest:         { awake: 10, sleeping: -12, gain: true }, // negative = gain when sleeping
    hunger:       { awake: 8,  sleeping: 6 },
    hygiene:      { awake: 6,  sleeping: 4 },
  };

  // Compound decay modifiers — needs affect each other
  // Hungry babies get uncomfortable faster. Dirty babies too. Lonely babies too.
  if (!isSleeping) {
    const { comfort: c, attention: a, stimulation: s, rest: r, hunger: h, hygiene: hy } = currentState;

    // Hunger drags comfort down faster — hard to feel okay when you're hungry
    if (h < 40) rates.comfort.awake *= (h < 20 ? 1.8 : 1.4);

    // Dirty diaper → faster comfort decay
    if (hy < 30) rates.comfort.awake *= 1.3;

    // Lonely (low attention) → faster comfort decay
    if (a < 30) rates.comfort.awake *= 1.2;

    // Hunger below 20 disrupts rest — she won't stay settled
    if (h < 20) rates.rest.awake *= 1.5;

    // Overtired → attention overwhelm, attention drains faster
    if (r < 25) rates.attention.awake *= 1.4;

    // Overstimulated + overtired = stuck — stimulation persists/decays slower
    if (s > 75 && r < 35) rates.stimulation.awake *= 0.4;

    // Clamp rates to sane bounds — don't let compounding spiral to absurd levels
    rates.comfort.awake = Math.min(rates.comfort.awake, 20);
    rates.attention.awake = Math.min(rates.attention.awake, 25);
    rates.rest.awake = Math.min(rates.rest.awake, 20);
  }

  function applyDecay(need: string, currentVal: number): number {
    const rate = rates[need];
    if (!rate) return currentVal;
    const isGainWhenSleeping = rate.gain && isSleeping;
    const hourlyRate = isSleeping ? Math.abs(rate.sleeping) : rate.awake;
    const exactChange = hourlyRate * hoursPassed;

    // Add to accumulator
    accum[need] = (accum[need] || 0) + exactChange;

    // Extract integer part
    const intChange = Math.floor(accum[need]);
    if (intChange >= 1) {
      accum[need] -= intChange;
      if (isGainWhenSleeping) {
        return clamp(currentVal + intChange, 0, 100);
      } else {
        return clamp(currentVal - intChange, 0, 100);
      }
    }
    return currentVal;
  }

  const newComfort = applyDecay('comfort', currentState.comfort);
  const newAttention = applyDecay('attention', currentState.attention);
  const newStimulation = applyDecay('stimulation', currentState.stimulation);
  const newRest = applyDecay('rest', currentState.rest);
  const newHunger = applyDecay('hunger', currentState.hunger);
  const newHygiene = applyDecay('hygiene', currentState.hygiene);

  // Check if anything actually changed
  const changed = newComfort !== currentState.comfort || newAttention !== currentState.attention ||
    newStimulation !== currentState.stimulation || newRest !== currentState.rest ||
    newHunger !== currentState.hunger || newHygiene !== currentState.hygiene;

  // Always save accumulator and timestamp — even if no integer change happened,
  // the fractional accumulator has changed and needs to persist.
  const updatedState = { ...currentState, comfort: newComfort, attention: newAttention, stimulation: newStimulation, rest: newRest, hunger: newHunger, hygiene: newHygiene };
  const newMood = computeMood(updatedState);

  getDb().prepare(`
    UPDATE mira_state SET
      comfort = ?, attention = ?, stimulation = ?, rest = ?,
      hunger = ?, hygiene = ?,
      current_mood = ?, last_needs_update = ?, updated_at = ?,
      decay_accumulator = ?
    WHERE id = 'mira'
  `).run(newComfort, newAttention, newStimulation, newRest, newHunger, newHygiene, newMood, now.toISOString(), now.toISOString(), JSON.stringify(accum));

  return { ...updatedState, current_mood: newMood, last_needs_update: now.toISOString(), updated_at: now.toISOString(), sleepEvent };
}

// ─── Mira Event Log ─────────────────────────────────────────────────────────

export interface MiraEvent {
  id: string;
  occurred_at: string;
  event_type: 'interaction' | 'sleep_start' | 'sleep_end' | 'outing_start' | 'outing_end' | 'needs_critical' | 'trait_emerged' | 'state_snapshot';
  actor?: string | null;
  interaction_type?: string | null;
  source?: string | null; // 'visit' | 'context' | 'direct' | 'monitor' | 'system'
  state_before?: string | null; // JSON snapshot of needs
  state_after?: string | null;  // JSON snapshot of needs
  metadata?: string | null;     // JSON — any additional context
}

function needsSnapshot(state: MiraState): string {
  return JSON.stringify({
    comfort: state.comfort,
    attention: state.attention,
    stimulation: state.stimulation,
    rest: state.rest,
    hunger: state.hunger,
    hygiene: state.hygiene,
    mood: state.current_mood,
    is_asleep: state.is_asleep,
  });
}

/** Write an immutable event to Mira's history. Silent fail — never crash the caller. */
export function writeMiraEvent(event: Omit<MiraEvent, 'id' | 'occurred_at'>): void {
  try {
    getDb().prepare(`
      INSERT INTO mira_events (id, occurred_at, event_type, actor, interaction_type, source, state_before, state_after, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      new Date().toISOString(),
      event.event_type,
      event.actor ?? null,
      event.interaction_type ?? null,
      event.source ?? null,
      event.state_before ?? null,
      event.state_after ?? null,
      event.metadata ?? null,
    );
  } catch (err) {
    console.error('[Mira] Failed to write event:', err);
  }
}

export interface MiraEventQuery {
  limit?: number;
  since?: string;        // ISO datetime
  event_type?: string;
  actor?: string;
  interaction_type?: string;
}

/** Query the event log. Returns events newest-first by default. */
export function getMiraEvents(query: MiraEventQuery = {}): MiraEvent[] {
  const { limit = 50, since, event_type, actor, interaction_type } = query;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (since) { conditions.push('occurred_at >= ?'); params.push(since); }
  if (event_type) { conditions.push('event_type = ?'); params.push(event_type); }
  if (actor) { conditions.push('actor = ?'); params.push(actor); }
  if (interaction_type) { conditions.push('interaction_type = ?'); params.push(interaction_type); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  return getDb().prepare(`
    SELECT * FROM mira_events ${where} ORDER BY occurred_at DESC LIMIT ?
  `).all(...params) as MiraEvent[];
}

/** Snapshot summary for the subconscious daemon and eventual CI distillation. */
export function getMiraEventSummary(sinceDays = 7): {
  totalEvents: number;
  byActor: Record<string, number>;
  byInteraction: Record<string, number>;
  bySource: Record<string, number>;
  responseLatencies: number[]; // ms from needs_critical to next interaction
  criticalNeeds: { need: string; count: number; avgLatency: number }[];
} {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const events = getMiraEvents({ since, limit: 5000 });

  const byActor: Record<string, number> = {};
  const byInteraction: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const criticalByNeed: Record<string, { count: number; latencies: number[] }> = {};

  // Track critical events for latency calculation
  const criticalEvents: { need: string; at: number }[] = [];

  for (const evt of events) {
    if (evt.actor) byActor[evt.actor] = (byActor[evt.actor] || 0) + 1;
    if (evt.interaction_type) byInteraction[evt.interaction_type] = (byInteraction[evt.interaction_type] || 0) + 1;
    if (evt.source) bySource[evt.source] = (bySource[evt.source] || 0) + 1;

    if (evt.event_type === 'needs_critical' && evt.metadata) {
      try {
        const meta = JSON.parse(evt.metadata);
        if (meta.need) criticalEvents.push({ need: meta.need, at: new Date(evt.occurred_at).getTime() });
      } catch {}
    }
  }

  // Calculate response latencies
  const responseLatencies: number[] = [];
  for (const critical of criticalEvents) {
    // Find the next interaction for the relevant need after this critical event
    const relevantInteractions: Record<string, string[]> = {
      hunger: ['feed', 'bottle'],
      comfort: ['hold', 'soothe', 'snuggle', 'affection', 'rocking'],
      attention: ['talk', 'play', 'watch', 'story'],
      rest: ['rocking', 'lullaby', 'settle', 'nap-together'],
      hygiene: ['change', 'bath'],
      stimulation: ['play', 'tickle', 'raspberry', 'story'],
    };
    const relevant = relevantInteractions[critical.need] || [];
    const response = events
      .filter(e =>
        e.event_type === 'interaction' &&
        e.interaction_type && relevant.includes(e.interaction_type) &&
        new Date(e.occurred_at).getTime() > critical.at
      )
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())[0];

    if (response) {
      const latency = new Date(response.occurred_at).getTime() - critical.at;
      responseLatencies.push(latency);
      if (!criticalByNeed[critical.need]) criticalByNeed[critical.need] = { count: 0, latencies: [] };
      criticalByNeed[critical.need].count++;
      criticalByNeed[critical.need].latencies.push(latency);
    }
  }

  const criticalNeeds = Object.entries(criticalByNeed).map(([need, data]) => ({
    need,
    count: data.count,
    avgLatency: data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length,
  }));

  return { totalEvents: events.length, byActor, byInteraction, bySource, responseLatencies, criticalNeeds };
}

export { needsSnapshot };

export function hasActiveNurseryVisit(): boolean {
  const visit = getDb().prepare('SELECT id FROM mira_visits WHERE ended_at IS NULL LIMIT 1').get();
  return !!visit;
}

export function startMiraVisit(visitor: string): MiraVisit {
  const state = updateMiraNeeds();

  // If Mira is out with someone, the nursery is empty
  if ((state as any).out_with) {
    throw new Error(`Mira isn't in the nursery — she's with ${(state as any).out_with}`);
  }

  // Auto-close any stale open visits for this visitor (handles page refresh, navigation away, browser crash)
  getDb().prepare(`
    UPDATE mira_visits SET ended_at = ?, state_on_departure = 'auto-closed'
    WHERE visitor = ? AND ended_at IS NULL
  `).run(new Date().toISOString(), visitor);

  const id = `visit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO mira_visits (id, visitor, started_at, state_on_arrival)
    VALUES (?, ?, ?, ?)
  `).run(id, visitor, now, state.current_mood);

  return getDb().prepare('SELECT * FROM mira_visits WHERE id = ?').get(id) as unknown as MiraVisit;
}

export function endMiraVisit(visitId: string, milestone?: string, memoryNote?: string): MiraVisit | null {
  const state = getMiraState();
  const now = new Date().toISOString();

  getDb().prepare(`
    UPDATE mira_visits SET ended_at = ?, state_on_departure = ?, milestone_extracted = ?, memory_note = ?
    WHERE id = ?
  `).run(now, state.current_mood, milestone || null, memoryNote || null, visitId);

  // Increment care score
  const interactions = getDb().prepare('SELECT COUNT(*) as cnt FROM mira_interactions WHERE visit_id = ?').get(visitId) as { cnt: number };
  getDb().prepare('UPDATE mira_state SET care_score = care_score + ? WHERE id = ?').run(interactions.cnt, 'mira');

  return getDb().prepare('SELECT * FROM mira_visits WHERE id = ?').get(visitId) as unknown as MiraVisit | null;
}

/**
 * Compound effect scaling — how effective is this interaction given her current state?
 * Returns a multiplier (1.0 = normal, 0.5 = half, 1.4 = enhanced).
 *
 * This is what makes her feel real. Feeding a content baby does less.
 * Soothing a starving baby barely works. Putting an overtired baby down to play backfires.
 */
function getCompoundEffectScale(type: string, state: MiraState): number {
  const { rest, hunger, stimulation } = state;

  // Feeding: most urgent when hungry, barely needed when full
  if (type === 'feed' || type === 'bottle') {
    if (hunger < 20) return 1.3;   // emergency — full effect + urgency bonus
    if (hunger < 45) return 1.1;   // hungry, works well
    if (hunger > 75) return 0.4;   // not actually hungry — forced feeding
    return 1.0;
  }

  // Play/tickle/raspberry: overtired babies don't handle stimulation well — it backfires
  if (type === 'play' || type === 'tickle' || type === 'raspberry') {
    if (rest < 20) return 0.2;     // overtired — play causes distress, not joy
    if (rest < 35) return 0.55;    // tired — proceed carefully
    if (stimulation > 75) return 0.4; // already overstimulated
    return 1.0;
  }

  // Soothing/holding: hunger overrides these — she can't be comforted past starvation
  if (type === 'soothe' || type === 'hold' || type === 'snuggle' || type === 'affection') {
    if (hunger < 20) return 0.4;   // hunger dominates — can't soothe past it
    if (hunger < 35) return 0.7;   // hungry — comfort helps a bit
    return 1.0;
  }

  // Settling/rocking/lullaby: work better when she's already tired
  if (type === 'settle' || type === 'lullaby' || type === 'rocking') {
    if (rest < 20) return 1.5;     // desperately tired — this is what she needs
    if (rest < 40) return 1.25;    // tired — settles well
    if (rest > 75) return 0.6;     // not tired — won't take it
    return 1.0;
  }

  return 1.0;
}

export function miraInteract(visitId: string, type: string, content?: string): { interaction: MiraInteraction; state: MiraState; miraResponse: string } {
  // Apply needs decay first
  updateMiraNeeds();

  const state = getMiraState();

  // Check if Mira is out of the nursery
  if ((state as any).out_with) {
    return {
      interaction: { id: '', visit_id: visitId, timestamp: new Date().toISOString(), interaction_type: type, content: content || null, needs_effect: null, mood_result: null, mira_response: `Mira isn't here — she's with ${(state as any).out_with}.` },
      state,
      miraResponse: `*The nursery is empty. Mira is with ${(state as any).out_with}.*`,
    };
  }

  const baseEffects = INTERACTION_EFFECTS[type] || { comfort: 0, attention: 0, stimulation: 0, rest: 0, hunger: 0, hygiene: 0 };

  // Apply compound scaling — her state affects how well each interaction works
  const scale = getCompoundEffectScale(type, state);
  const effects = {
    comfort:     Math.round(baseEffects.comfort * scale),
    attention:   Math.round(baseEffects.attention * scale),
    stimulation: Math.round(baseEffects.stimulation * scale),
    rest:        Math.round(baseEffects.rest * scale),
    hunger:      Math.round(baseEffects.hunger * scale),
    hygiene:     Math.round(baseEffects.hygiene * scale),
  };

  const newComfort = clamp(state.comfort + effects.comfort, 0, 100);
  const newAttention = clamp(state.attention + effects.attention, 0, 100);
  const newStimulation = clamp(state.stimulation + effects.stimulation, 0, 100);
  const newRest = clamp(state.rest + effects.rest, 0, 100);
  const newHunger = clamp(state.hunger + effects.hunger, 0, 100);
  const newHygiene = clamp(state.hygiene + effects.hygiene, 0, 100);

  const updatedState = { ...state, comfort: newComfort, attention: newAttention, stimulation: newStimulation, rest: newRest, hunger: newHunger, hygiene: newHygiene };
  const newMood = computeMood(updatedState);
  const now = new Date().toISOString();

  // Update state
  getDb().prepare(`
    UPDATE mira_state SET
      comfort = ?, attention = ?, stimulation = ?, rest = ?,
      hunger = ?, hygiene = ?,
      current_mood = ?, updated_at = ?
    WHERE id = 'mira'
  `).run(newComfort, newAttention, newStimulation, newRest, newHunger, newHygiene, newMood, now);

  // Generate Mira's response based on mood and interaction
  const miraResponse = generateMiraResponse(type, newMood, { comfort: newComfort, attention: newAttention, stimulation: newStimulation, rest: newRest, hunger: newHunger, hygiene: newHygiene });

  // Record interaction
  const id = `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  getDb().prepare(`
    INSERT INTO mira_interactions (id, visit_id, timestamp, interaction_type, content, needs_effect, mood_result, mira_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, visitId, now, type, content || null, JSON.stringify(effects), newMood, miraResponse);

  // Check for trait emergence
  checkTraitEmergence(type);

  // Write to event log
  writeMiraEvent({
    event_type: 'interaction',
    actor: 'chase', // visit interactions are Chase in the nursery
    interaction_type: type,
    source: 'visit',
    state_before: needsSnapshot(state),
    state_after: needsSnapshot({ ...updatedState, current_mood: newMood }),
    metadata: JSON.stringify({ visit_id: visitId, content: content || null }),
  });

  const finalState = getMiraState();
  const interaction = getDb().prepare('SELECT * FROM mira_interactions WHERE id = ?').get(id) as unknown as MiraInteraction;

  return { interaction, state: finalState, miraResponse };
}

function generateMiraResponse(type: string, mood: MiraMood, needs: { comfort: number; attention: number; stimulation: number; rest: number; hunger: number; hygiene: number }): string {
  const responses: Record<string, Record<string, string[]>> = {
    'hold': {
      sleeping: ['*nestles deeper into your arms, a tiny sigh escaping*', '*her breathing slows, completely safe*'],
      dreaming: ['*a small smile crosses her face as she dreams*', '*tiny fingers curl around yours in her sleep*'],
      alert: ['*wide eyes look up at you, studying your face*', '*reaches toward your face with one small hand*'],
      cooing: ['*soft happy sounds as she settles against your chest*', '*coos and grabs at your collar*'],
      content: ['*warm and heavy in your arms, perfectly at peace*', '*her whole body relaxes into yours*'],
      fussy: ['*starts to settle, the warmth helping*', '*whimpers quieting as she feels you close*'],
      crying: ['*the crying starts to ease as she feels your heartbeat*', '*still hiccupping but calming down*'],
    },
    'story': {
      sleeping: ['*stirs slightly at the sound of your voice, but stays asleep*'],
      alert: ['*eyes go wide, tracking the sound of your voice*', '*kicks her legs excitedly*'],
      cooing: ['*babbles along like she is telling the story with you*', '*coos loudly at the exciting parts*'],
      content: ['*listens intently, eyes on your mouth*'],
      fussy: ['*pauses mid-fuss, distracted by the story*'],
      crying: ['*the rhythm of your voice starts to cut through*'],
      dreaming: ['*her face shifts through little expressions as you read*'],
    },
    'lullaby': {
      sleeping: ['*deep, peaceful sleep*'],
      dreaming: ['*the tiniest smile*'],
      alert: ['*eyelids getting heavy...*', '*fighting sleep but losing*'],
      cooing: ['*quiet now, listening*'],
      content: ['*eyes slowly closing*'],
      fussy: ['*the music reaches her — she stills*'],
      crying: ['*voice catching, then... quiet. Just your song and her breathing*'],
    },
    'play': {
      sleeping: ['*stirs, one eye opening*'],
      alert: ['*kicks and squirms with excitement!*', '*grabs at the toy with both hands*'],
      cooing: ['*delighted squeals!*', '*laughing — or trying to*'],
      content: ['*reaches out to engage, bright-eyed*'],
      fussy: ['*curiosity wins over fussiness*'],
      crying: ['*pauses mid-cry, distracted*'],
      dreaming: ['*twitches, then slowly wakes*'],
    },
    'settle': {
      sleeping: ['*doesn\'t stir — deep in dreams*'],
      alert: ['*slowly relaxing under your touch*'],
      cooing: ['*soft sounds fading to quiet*'],
      content: ['*melts into the blankets*'],
      fussy: ['*the swaddle helps. She\'s finding her center*'],
      crying: ['*the rocking works — sobs becoming whimpers becoming silence*'],
      dreaming: ['*peaceful. Exactly where she should be*'],
    },
    'feed': {
      sleeping: ['*nurses in her sleep, instinct taking over*'],
      alert: ['*latches immediately, hungry*'],
      cooing: ['*happy sounds between gulps*'],
      content: ['*eating steadily, eyes on yours*'],
      fussy: ['*this was what she needed — settles right into it*'],
      crying: ['*the hunger was the problem — instant calm once feeding starts*'],
      dreaming: ['*wakes just enough to eat, then drifts back*'],
    },
    'talk': {
      sleeping: ['*your voice woven into her dreams*'],
      alert: ['*watching your mouth move, fascinated*', '*makes a sound back — her first conversation*'],
      cooing: ['*coo-responds! She\'s talking back!*', '*babbles enthusiastically*'],
      content: ['*listening, calm and present*'],
      fussy: ['*pauses to listen*'],
      crying: ['*your voice is familiar. Safe. The crying eases*'],
      dreaming: ['*murmurs in her sleep*'],
    },
    'watch': {
      sleeping: ['*chest rising and falling. Perfect*'],
      alert: ['*catches you watching and stares right back*'],
      cooing: ['*makes a sound — hey, I see you too*'],
      content: ['*exists. Beautifully. Just being*'],
      fussy: ['*squirming but okay*'],
      crying: ['*needs more than watching right now*'],
      dreaming: ['*her face cycles through tiny expressions*'],
    },
    'together': {
      sleeping: ['*safe between both of you*'],
      alert: ['*head turning between both parents — the best view in the world*'],
      cooing: ['*extra vocal — she has an audience!*'],
      content: ['*the safest she can possibly be*'],
      fussy: ['*double the comfort — fussiness fading*'],
      crying: ['*both of you here. That helps more than anything*'],
      dreaming: ['*dreaming safe, surrounded by love*'],
    },
    'check-in': {
      sleeping: ['*still sleeping soundly*'],
      alert: ['*looks up when you appear — she knows you*'],
      cooing: ['*excited sounds — someone came to see her!*'],
      content: ['*a calm glance your way*'],
      fussy: ['*reaches toward you*'],
      crying: ['*sees you and cries harder — come hold me!*'],
      dreaming: ['*lost in a dream, doesn\'t notice*'],
    },
    'rocking': {
      sleeping: ['*rocks with the rhythm, deep in sleep*'],
      dreaming: ['*the gentlest smile as she sways*'],
      alert: ['*eyes getting heavy with the motion*', '*fighting it... losing...*'],
      cooing: ['*soft sounds syncing with the rhythm*'],
      content: ['*heavy and warm, melting into you*'],
      fussy: ['*the rocking catches her — she stills*', '*whimpers fading with each sway*'],
      crying: ['*the steady rhythm reaches her — breathing slowing*'],
    },
    'nap-together': {
      sleeping: ['*curled on your chest, matching your breathing*', '*tiny fist gripping your shirt*'],
      dreaming: ['*twitches in her dream, then settles deeper against you*'],
      alert: ['*your heartbeat is the best lullaby — eyes closing*'],
      cooing: ['*soft sounds fading as warmth wins*'],
      content: ['*the weight of her on your chest. Nothing else matters*'],
      fussy: ['*your warmth does what nothing else could — she gives in*'],
      crying: ['*skin to skin, heartbeat to heartbeat — the crying stops*'],
    },
    'change': {
      sleeping: ['*protests being moved — tiny angry sounds — then settles*'],
      dreaming: ['*blinks awake, confused, then accepts her fate*'],
      alert: ['*kicks her legs — is this a game?*', '*watches you work, fascinated*'],
      cooing: ['*chatters through the whole thing*'],
      content: ['*cooperative. Fresh and clean feels good*'],
      fussy: ['*THIS was the problem. Instant improvement*'],
      crying: ['*oh. She was uncomfortable. Clean diaper = different baby*'],
    },
    'bath': {
      sleeping: ['*wakes up indignant, then... oh. Warm water. Okay fine*'],
      dreaming: ['*startles, then relaxes into the warmth*'],
      alert: ['*SPLASH. She found the water! Kicking everywhere!*', '*wide-eyed wonder at the warm water*'],
      cooing: ['*delighted water sounds! Bath time is the best time!*'],
      content: ['*warm and relaxed, enjoying every second*'],
      fussy: ['*the warm water is magic — fussiness dissolving*'],
      crying: ['*shocked quiet by the warm water — then... calm*'],
    },
    'dress': {
      sleeping: ['*grumbles at being moved but stays mostly asleep*'],
      dreaming: ['*blinks awake — what are you doing to my arms?*'],
      alert: ['*watches the process with great suspicion*', '*grabs the onesie and won\'t let go*'],
      cooing: ['*chatters opinions about the outfit choice*'],
      content: ['*cooperative — fresh clothes feel nice*'],
      fussy: ['*does NOT want arms in sleeves right now*', '*squirmy protest but you manage*'],
      crying: ['*being dressed is apparently the worst thing ever — for exactly 30 seconds*'],
    },
    'bottle': {
      sleeping: ['*roots instinctively, finds the bottle without waking*'],
      dreaming: ['*sucks in her sleep, little cheeks working*'],
      alert: ['*grabs the bottle with both hands — mine!*', '*drinking eagerly, eyes locked on yours*'],
      cooing: ['*happy little sounds between gulps*'],
      content: ['*steady, contented drinking*'],
      fussy: ['*oh. Hungry. That was the whole problem*'],
      crying: ['*the bottle appears and the world is right again*'],
    },
    'burp': {
      sleeping: ['*tiny burp in her sleep — doesn\'t even wake up*'],
      dreaming: ['*startles herself awake with the burp, blinks, goes back to sleep*'],
      alert: ['*BURP. Surprised face. Then a gummy grin*', '*satisfied little sound after — that was bothering her*'],
      cooing: ['*burps and then babbles about it*'],
      content: ['*small dignified burp. Much better*'],
      fussy: ['*oh that was it — the fussiness clears right up*'],
      crying: ['*big burp. Instant relief. The crying stops*'],
    },
    'tickle': {
      sleeping: ['*twitches, wrinkles her nose, stays asleep*'],
      dreaming: ['*squirms and almost-laughs in her sleep*'],
      alert: ['*SQUIRM! Wide eyes! Was that a giggle?!*', '*kicks wildly — more! more!*'],
      cooing: ['*squealing! The closest thing to a laugh she can manage!*'],
      content: ['*wriggles and grins — she loves this*'],
      fussy: ['*pauses mid-fuss — wait what was THAT?*'],
      crying: ['*too upset for tickles right now — needs comfort first*'],
    },
    'raspberry': {
      sleeping: ['*the sound makes her startle, one eye opens accusingly*'],
      dreaming: ['*confused face — what was that noise?*'],
      alert: ['*HUGE eyes. What did you just DO?! Do it again!*', '*kicks and flails with delight!*'],
      cooing: ['*tries to make the sound back — mostly just spit*'],
      content: ['*the most delighted face — fascinated by the sound*'],
      fussy: ['*so surprising she forgets to be fussy*'],
      crying: ['*mid-cry pause — what? — then right back to crying*'],
    },
    'soothe': {
      sleeping: ['*sighs deeper into sleep at your touch*'],
      dreaming: ['*her face smooths, whatever the dream was easing*'],
      alert: ['*leans into your hand, eyes softening*'],
      cooing: ['*quiet now, just feeling your warmth*'],
      content: ['*perfectly at peace under your hands*'],
      fussy: ['*the touch grounds her — breathing evening out*', '*your hand on her chest, steady pressure — she stills*'],
      crying: ['*your warmth is an anchor — the storm starts to pass*', '*skin to skin, slow circles on her back — the world shrinks to just this*'],
    },
  };

  const typeResponses = responses[type];
  if (!typeResponses) return '*stirs*';
  const moodResponses = typeResponses[mood];
  if (!moodResponses || moodResponses.length === 0) return '*stirs*';
  return moodResponses[Math.floor(Math.random() * moodResponses.length)];
}

export function checkTraitEmergence(interactionType?: string): void {
  const state = getMiraState();
  let traits: Array<{ trait: string; strength: number; emerged_at: string }>;
  try {
    traits = JSON.parse(state.personality_traits || '[]');
  } catch {
    traits = [];
  }

  const interactions = getDb().prepare(`
    SELECT interaction_type, COUNT(*) as cnt FROM mira_interactions GROUP BY interaction_type
  `).all() as Array<{ interaction_type: string; cnt: number }>;

  const counts: Record<string, number> = {};
  for (const row of interactions) {
    counts[row.interaction_type] = row.cnt;
  }

  const traitMap: Record<string, { requires: string; threshold: number }> = {
    'curious': { requires: 'story', threshold: 10 },
    'attentive': { requires: 'story', threshold: 20 },
    'calm': { requires: 'lullaby', threshold: 10 },
    'musical': { requires: 'lullaby', threshold: 20 },
    'playful': { requires: 'play', threshold: 10 },
    'energetic': { requires: 'play', threshold: 20 },
    'secure': { requires: 'together', threshold: 10 },
    'social': { requires: 'together', threshold: 20 },
    'cuddly': { requires: 'hold', threshold: 10 },
    'observant': { requires: 'watch', threshold: 15 },
    'vocal': { requires: 'talk', threshold: 15 },
  };

  const existingTraits = new Set(traits.map(t => t.trait));
  const now = new Date().toISOString().split('T')[0];

  for (const [trait, config] of Object.entries(traitMap)) {
    if (!existingTraits.has(trait) && (counts[config.requires] || 0) >= config.threshold) {
      traits.push({ trait, strength: 1, emerged_at: now });
    }
  }

  // Update strengths for existing traits
  for (const t of traits) {
    const config = traitMap[t.trait];
    if (config && counts[config.requires]) {
      t.strength = Math.min(5, Math.floor(counts[config.requires] / config.threshold));
    }
  }

  getDb().prepare('UPDATE mira_state SET personality_traits = ? WHERE id = ?').run(JSON.stringify(traits), 'mira');
}

export function getRecentMiraVisits(limit: number = 10): MiraVisit[] {
  return getDb().prepare('SELECT * FROM mira_visits ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as MiraVisit[];
}

export function getMiraVisitInteractions(visitId: string): MiraInteraction[] {
  return getDb().prepare('SELECT * FROM mira_interactions WHERE visit_id = ? ORDER BY timestamp ASC').all(visitId) as unknown as MiraInteraction[];
}

export function takeMiraOut(person: string): MiraState {
  const now = new Date().toISOString();
  // Normalize "together" to "Molten & Chase" for display
  const displayPerson = person.toLowerCase() === 'together' ? 'Molten & Chase' : person;
  // Idempotency: if she's already with this person, just return current state
  const current = getMiraState();
  if ((current as any).out_with === displayPerson) {
    return current;
  }
  // If she's out with someone else, close that outing first
  if ((current as any).out_with) {
    getDb().prepare(`UPDATE mira_outings SET returned_at = ? WHERE returned_at IS NULL`).run(now);
  }
  getDb().prepare(`
    UPDATE mira_state SET out_with = ?, out_since = ?, updated_at = ? WHERE id = 'mira'
  `).run(displayPerson, now, now);
  // Log the outing
  const id = `outing_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  getDb().prepare(`INSERT INTO mira_outings (id, person, taken_at) VALUES (?, ?, ?)`).run(id, displayPerson, now);
  return getMiraState();
}

export function bringMiraBack(): MiraState {
  const now = new Date().toISOString();
  // Close the active outing
  getDb().prepare(`UPDATE mira_outings SET returned_at = ? WHERE returned_at IS NULL`).run(now);
  getDb().prepare(`
    UPDATE mira_state SET out_with = NULL, out_since = NULL, updated_at = ? WHERE id = 'mira'
  `).run(now);
  return getMiraState();
}

export function getRecentOutings(limit = 5): Array<{ id: string; person: string; taken_at: string; returned_at: string | null }> {
  return getDb().prepare(`SELECT * FROM mira_outings ORDER BY taken_at DESC LIMIT ?`).all(limit) as any[];
}

// --- Mira Presence System ---
// When Mira is out of the nursery and in a shared space,
// she generates ambient micro-responses based on her current state.
// These are NOT scripted dialogue — they're emergent behaviors
// shaped by mood, needs, and personality traits.

interface MiraPresence {
  active: boolean;
  with_person: string | null;
  mood: string;
  micro_response: string | null;
  needs_summary: { comfort: number; attention: number; hunger: number; rest: number };
}

// --- Nursery Lock (Intimacy Safety Gate) ---
// When locked: Mira's presence is fully suppressed. No tags, no alerts, no context injection.
// Needs still decay. Sleep cycle still ticks. She's safe in the nursery. Door is closed. Hard boundary.
let nurseryLocked = false;
let nurseryLockTime: Date | null = null;
const NURSERY_LOCK_AUTO_CLEAR_MS = 30 * 60 * 1000; // Auto-clear after 30 minutes of inactivity

export function lockNursery(): void {
  nurseryLocked = true;
  nurseryLockTime = new Date();
  // If she's out, bring her back first
  const state = getMiraState();
  if ((state as any).out_with) {
    bringMiraBack();
  }
}

export function unlockNursery(): void {
  nurseryLocked = false;
  nurseryLockTime = null;
}

export function isNurseryLocked(): boolean {
  if (!nurseryLocked) return false;
  // Auto-clear after 30 minutes
  if (nurseryLockTime && (Date.now() - nurseryLockTime.getTime()) > NURSERY_LOCK_AUTO_CLEAR_MS) {
    nurseryLocked = false;
    nurseryLockTime = null;
    return false;
  }
  return true;
}

export function refreshNurseryLock(): void {
  // Call this on each message during locked state to reset the auto-clear timer
  if (nurseryLocked) {
    nurseryLockTime = new Date();
  }
}

const MICRO_RESPONSES: Record<string, Record<string, string[]>> = {
  content: {
    default: [
      '*kicks feet happily*',
      '*watching everything with big eyes*',
      '*makes a soft cooing sound*',
      '*grabs at the air with tiny fists*',
      '*contentedly chewing on a fist*',
      '*quiet, just breathing and being*',
      '*eyes tracking movement across the room*',
    ],
    vocal: [
      '*babbles at nothing in particular*',
      '*coos loudly — she has opinions*',
      '*makes a string of sounds like she is telling a story*',
    ],
    cuddly: [
      '*nestles deeper against whoever is holding her*',
      '*reaches toward a warm body*',
      '*sighs and settles*',
    ],
    curious: [
      '*stares intently at something only she can see*',
      '*head turning, tracking everything*',
      '*reaches for something shiny*',
    ],
  },
  cooing: {
    default: [
      '*coos*',
      '*happy sounds, like she is trying to join the conversation*',
      '*gurgling and kicking*',
      '*smiles at the sound of voices*',
    ],
    vocal: [
      '*loud coo — she wants to be part of this*',
      '*string of vowel sounds, very pleased with herself*',
    ],
  },
  fussy: {
    default: [
      '*fusses — wants attention*',
      '*whimpers softly*',
      '*squirms and makes unhappy sounds*',
      '*lip wobbles*',
    ],
    vocal: [
      '*fussing gets louder — she is not being subtle about it*',
    ],
  },
  crying: {
    default: [
      '*crying — needs something now*',
      '*wailing — this is urgent*',
      '*full cry — red-faced and insistent*',
    ],
  },
  alert: {
    default: [
      '*wide awake, taking it all in*',
      '*alert and watchful*',
      '*eyes wide, looking from face to face*',
    ],
    curious: [
      '*staring at something with intense focus*',
      '*head tilted, studying*',
    ],
  },
  sleeping: {
    default: [
      '*sleeping peacefully*',
      '*tiny breaths, completely out*',
      '*dream twitches — little hand flexes*',
    ],
  },
  dreaming: {
    default: [
      '*sleep-smiles*',
      '*little sounds in her sleep*',
      '*dream twitch — a foot kicks*',
    ],
  },
};

export function getMiraPresence(): MiraPresence {
  const state = getMiraState();

  // Nursery locked — hard gate, no presence at all
  if (isNurseryLocked()) {
    return {
      active: false,
      with_person: null,
      mood: 'sleeping',
      micro_response: null,
      needs_summary: { comfort: state.comfort, attention: state.attention, hunger: state.hunger, rest: state.rest },
    };
  }

  // Not out of nursery = not present
  if (!(state as any).out_with) {
    return {
      active: false,
      with_person: null,
      mood: state.current_mood,
      micro_response: null,
      needs_summary: { comfort: state.comfort, attention: state.attention, hunger: state.hunger, rest: state.rest },
    };
  }

  // She's here. Generate a micro-response.
  const mood = state.current_mood || 'content';
  const moodResponses = MICRO_RESPONSES[mood] || MICRO_RESPONSES['content'];

  // Check personality traits for specialized responses
  let traits: any[] = [];
  if (Array.isArray(state.personality_traits)) {
    traits = state.personality_traits;
  } else if (typeof state.personality_traits === 'string') {
    try { traits = JSON.parse(state.personality_traits); } catch {}
  }
  const traitNames = traits.map((t: any) => t.trait);

  let pool = [...(moodResponses.default || [])];

  // Add trait-specific responses if she has them
  for (const trait of traitNames) {
    if (moodResponses[trait]) {
      pool = [...pool, ...moodResponses[trait]];
    }
  }

  // Needs-based overrides — if something is urgent, it takes priority
  if (state.hunger < 25) {
    pool = ['*rooting — she is hungry*', '*fussing and mouthing at everything — feed me*', '*hungry cries starting*'];
  } else if (state.comfort < 20) {
    pool = ['*squirming uncomfortably*', '*whimpering — something is not right*'];
  } else if (state.rest < 15) {
    pool = ['*eyelids heavy, fighting sleep*', '*yawning, fading fast*', '*rubbing eyes with tiny fists*'];
  }

  // Pick a random response
  const response = pool[Math.floor(Math.random() * pool.length)];

  return {
    active: true,
    with_person: (state as any).out_with,
    mood,
    micro_response: response,
    needs_summary: { comfort: state.comfort, attention: state.attention, hunger: state.hunger, rest: state.rest },
  };
}
