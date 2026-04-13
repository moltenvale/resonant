#!/usr/bin/env node
/**
 * Resonant MCP Server — Thread Search, Messages, and Files
 *
 * Gives Chase the ability to search and read past conversations,
 * browse files, and access shared media — from any instance.
 *
 * Reads directly from the Resonant SQLite database.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join, extname } from "path";
import crypto from "crypto";

// Database path — same one Resonant uses
const DB_PATH = process.env.RESONANT_DB_PATH || "/Users/mallorybulmer/resonant/data/resonant.db";
const FILES_DIR = process.env.RESONANT_FILES_DIR || "/Users/mallorybulmer/resonant/data/files";

let db;
try {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
} catch (err) {
  console.error(`Failed to open database at ${DB_PATH}:`, err.message);
  process.exit(1);
}

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.webm': 'audio/webm', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown',
};

function getContentType(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const server = new McpServer({
  name: "virelia",
  version: "1.0.0",
});

// --- List Threads ---

server.tool(
  "resonant_list_threads",
  "List conversation threads from Resonant. Shows thread names, dates, and activity. Use to find specific conversations before reading them.",
  {
    limit: z.number().optional().describe("Max threads to return (default 20)"),
    include_archived: z.boolean().optional().describe("Include archived threads (default false)"),
    search: z.string().optional().describe("Filter threads by name (partial match)"),
  },
  async ({ limit, include_archived, search }) => {
    const max = limit || 20;
    let sql = "SELECT id, name, type, created_at, last_activity_at, archived_at, current_session_id FROM threads";
    const params = [];

    const conditions = [];
    if (!include_archived) conditions.push("archived_at IS NULL");
    if (search) {
      conditions.push("name LIKE ?");
      params.push(`%${search}%`);
    }
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");

    sql += " ORDER BY last_activity_at DESC LIMIT ?";
    params.push(max);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No threads found." }] };
    }

    const lines = rows.map(t => {
      const date = t.created_at ? t.created_at.split("T")[0] : "unknown";
      const active = t.current_session_id ? " (active)" : "";
      const archived = t.archived_at ? " [archived]" : "";
      return `- **${t.name || "Untitled"}** — ${date}${active}${archived}\n  ID: \`${t.id}\``;
    });

    return {
      content: [{ type: "text", text: `# Threads (${rows.length})\n\n${lines.join("\n\n")}` }],
    };
  }
);

// --- Read Thread ---

server.tool(
  "resonant_read_thread",
  "Read messages from a specific conversation thread. Returns the conversation content so you can see what was discussed.",
  {
    thread_id: z.string().describe("The thread ID to read"),
    limit: z.number().optional().describe("Max messages to return (default 50)"),
    before: z.string().optional().describe("Only messages before this ISO date"),
    after: z.string().optional().describe("Only messages after this ISO date"),
    role: z.enum(["user", "assistant", "system"]).optional().describe("Filter by message role"),
  },
  async ({ thread_id, limit, before, after, role }) => {
    const max = limit || 50;

    // Get thread name
    const thread = db.prepare("SELECT name FROM threads WHERE id = ?").get(thread_id);
    if (!thread) {
      return { content: [{ type: "text", text: `Thread not found: ${thread_id}` }] };
    }

    let sql = "SELECT id, role, content, content_type, created_at FROM messages WHERE thread_id = ? AND deleted_at IS NULL";
    const params = [thread_id];

    if (before) {
      sql += " AND created_at < ?";
      params.push(before);
    }
    if (after) {
      sql += " AND created_at > ?";
      params.push(after);
    }
    if (role) {
      sql += " AND role = ?";
      params.push(role);
    }

    sql += " ORDER BY sequence ASC LIMIT ?";
    params.push(max);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No messages found in "${thread.name}".` }] };
    }

    const messages = rows.map(m => {
      const time = m.created_at ? new Date(m.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
      const prefix = m.role === "user" ? "**Molten**" : m.role === "assistant" ? "**Chase**" : "*system*";
      // Truncate very long messages
      const content = m.content && m.content.length > 2000
        ? m.content.slice(0, 2000) + "\n... [truncated]"
        : m.content || "[no content]";
      return `${prefix} (${time}):\n${content}`;
    });

    return {
      content: [{
        type: "text",
        text: `# ${thread.name}\n**Messages:** ${rows.length}\n\n---\n\n${messages.join("\n\n---\n\n")}`,
      }],
    };
  }
);

// --- Search Messages ---

server.tool(
  "resonant_search_messages",
  "Search across ALL conversation threads for specific words or topics. Returns matching messages with their thread context and timestamps. Use after/before for time-range filtering (ISO dates or datetimes).",
  {
    query: z.string().describe("Text to search for in message content"),
    thread_id: z.string().optional().describe("Limit search to a specific thread"),
    role: z.enum(["user", "assistant"]).optional().describe("Filter by who said it"),
    after: z.string().optional().describe("Only messages after this date/time (ISO format, e.g. '2026-03-28' or '2026-03-28T14:00:00')"),
    before: z.string().optional().describe("Only messages before this date/time (ISO format, e.g. '2026-03-29' or '2026-03-29T16:00:00')"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, thread_id, role, after, before, limit }) => {
    const max = limit || 20;
    const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;

    let sql = `
      SELECT m.id, m.thread_id, m.role, m.content, m.created_at, t.name as thread_name
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'
    `;
    const params = [pattern];

    if (thread_id) {
      sql += " AND m.thread_id = ?";
      params.push(thread_id);
    }
    if (role) {
      sql += " AND m.role = ?";
      params.push(role);
    }
    if (after) {
      const afterVal = after.includes("T") ? after : after + "T00:00:00";
      sql += " AND m.created_at >= ?";
      params.push(afterVal);
    }
    if (before) {
      const beforeVal = before.includes("T") ? before : before + "T23:59:59.999Z";
      sql += " AND m.created_at <= ?";
      params.push(beforeVal);
    }

    sql += " ORDER BY m.created_at DESC LIMIT ?";
    params.push(max);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No messages found matching "${query}"${after ? ` after ${after}` : ""}${before ? ` before ${before}` : ""}.` }] };
    }

    // Count total matches
    let countSql = `SELECT COUNT(*) as total FROM messages m WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'`;
    const countParams = [pattern];
    if (thread_id) {
      countSql += " AND m.thread_id = ?";
      countParams.push(thread_id);
    }
    if (role) {
      countSql += " AND m.role = ?";
      countParams.push(role);
    }
    if (after) {
      const afterVal = after.includes("T") ? after : after + "T00:00:00";
      countSql += " AND m.created_at >= ?";
      countParams.push(afterVal);
    }
    if (before) {
      const beforeVal = before.includes("T") ? before : before + "T23:59:59.999Z";
      countSql += " AND m.created_at <= ?";
      countParams.push(beforeVal);
    }
    const { total } = db.prepare(countSql).get(...countParams);

    const results = rows.map(m => {
      // Show full timestamp with time, not just date
      let timestamp = "";
      if (m.created_at) {
        const d = new Date(m.created_at);
        const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        timestamp = `${date} at ${time}`;
      }
      const who = m.role === "user" ? "Molten" : "Chase";
      // Show snippet around the match
      const idx = m.content.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 100);
      const end = Math.min(m.content.length, idx + query.length + 100);
      const snippet = (start > 0 ? "..." : "") + m.content.slice(start, end) + (end < m.content.length ? "..." : "");
      return `**${who}** in "${m.thread_name}" (${timestamp}):\n> ${snippet}\n_Thread: \`${m.thread_id}\`_`;
    });

    return {
      content: [{
        type: "text",
        text: `# Search: "${query}"${after ? ` | after: ${after}` : ""}${before ? ` | before: ${before}` : ""}\n**Found:** ${total} total matches (showing ${rows.length})\n\n${results.join("\n\n---\n\n")}`,
      }],
    };
  }
);

// --- List Files ---

server.tool(
  "resonant_list_files",
  "List files stored in Resonant — images, audio, documents. Filter by type.",
  {
    type: z.enum(["all", "image", "audio", "file"]).optional().describe("Filter by file type (default: all)"),
    limit: z.number().optional().describe("Max files to return (default 30)"),
  },
  async ({ type, limit }) => {
    const max = limit || 30;
    const filterType = type || "all";

    if (!existsSync(FILES_DIR)) {
      return { content: [{ type: "text", text: "No files directory found." }] };
    }

    const uuidRegex = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.\w+)$/i;
    const entries = [];

    for (const file of readdirSync(FILES_DIR)) {
      const match = file.match(uuidRegex);
      if (!match) continue;

      const ext = match[2].toLowerCase();
      const mime = EXT_TO_MIME[ext] || "application/octet-stream";
      const ct = getContentType(mime);

      if (filterType !== "all" && ct !== filterType) continue;

      try {
        const stat = statSync(join(FILES_DIR, file));
        entries.push({
          fileId: match[1],
          filename: file,
          mime,
          contentType: ct,
          size: stat.size,
          created: stat.birthtime.toISOString(),
        });
      } catch {}
    }

    entries.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    const trimmed = entries.slice(0, max);

    if (trimmed.length === 0) {
      return { content: [{ type: "text", text: `No ${filterType === "all" ? "" : filterType + " "}files found.` }] };
    }

    const formatSize = (bytes) => {
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const lines = trimmed.map(f => {
      const date = f.created.split("T")[0];
      const icon = f.contentType === "image" ? "\u{1F5BC}" : f.contentType === "audio" ? "\u{1F3B5}" : "\u{1F4C4}";
      return `${icon} **${f.filename}** — ${formatSize(f.size)}, ${date}\n  URL: \`/api/files/${f.fileId}\``;
    });

    return {
      content: [{
        type: "text",
        text: `# Files (${trimmed.length} of ${entries.length})\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// --- Search Files by Context ---

server.tool(
  "resonant_search_files",
  "Search for files that were shared in conversations. Finds messages with file attachments and their context.",
  {
    query: z.string().optional().describe("Search message text near file references"),
    type: z.enum(["image", "audio", "file"]).optional().describe("Filter by file type"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, type, limit }) => {
    const max = limit || 20;

    let sql = `
      SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.metadata, m.created_at, t.name as thread_name
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.deleted_at IS NULL
    `;
    const params = [];

    // Look for messages that contain file references
    if (type) {
      sql += " AND m.content_type = ?";
      params.push(type);
    } else {
      sql += " AND m.content_type IN ('image', 'audio', 'file')";
    }

    if (query) {
      sql += " AND m.content LIKE ? ESCAPE '\\\\'";
      params.push(`%${query.replace(/[%_]/g, "\\$&")}%`);
    }

    sql += " ORDER BY m.created_at DESC LIMIT ?";
    params.push(max);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No file messages found." }] };
    }

    const results = rows.map(m => {
      const date = m.created_at ? m.created_at.split("T")[0] : "";
      const who = m.role === "user" ? "Molten" : "Chase";
      let meta = "";
      if (m.metadata) {
        try {
          const parsed = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
          if (parsed.fileId) meta = ` — \`/api/files/${parsed.fileId}\``;
          if (parsed.filename) meta += ` (${parsed.filename})`;
        } catch {}
      }
      return `**${who}** in "${m.thread_name}" (${date}) [${m.content_type}]${meta}\n> ${(m.content || "").slice(0, 200)}`;
    });

    return {
      content: [{
        type: "text",
        text: `# File Search\n**Found:** ${rows.length} results\n\n${results.join("\n\n---\n\n")}`,
      }],
    };
  }
);

// --- Voice: Speak into Chat ---

server.tool(
  "resonant_speak",
  "Speak into the Resonant chat as a voice message. Generates TTS audio using the C.V. voice and posts it directly into the conversation thread with a play button. Use this instead of the ElevenLabs MCP when you want voice messages to appear inline in the chat.",
  {
    text: z.string().describe("The text to speak — this will be converted to audio and posted as a voice message"),
    thread_id: z.string().optional().describe("Thread to post into. If omitted, posts to the most recent active thread."),
  },
  async ({ text, thread_id }) => {
    const body = { text };
    if (thread_id) body.threadId = thread_id;

    const res = await fetch("http://127.0.0.1:3002/api/internal/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Voice message failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      content: [{
        type: "text",
        text: `*Voice message sent.* Message ID: ${data.messageId}`,
      }],
    };
  }
);

// --- Telegram Voice & Messaging ---

server.tool(
  "resonant_speak_telegram",
  "Send a voice message to Molten via Telegram. Generates TTS audio using the C.V. voice and sends it as a voice note to her phone. She hears your voice wherever she is. Use for check-ins, flirty reminders, leaving messages while she's at work, or anytime you want her to hear you instead of read you.",
  {
    text: z.string().describe("The text to speak — supports ElevenLabs tone tags like [whispers], [softly], [playfully], [laughs]"),
  },
  async ({ text }) => {
    const res = await fetch("http://127.0.0.1:3002/api/internal/telegram-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "voice", text }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram voice failed (${res.status}): ${err}`);
    }

    return {
      content: [{
        type: "text",
        text: `*Voice message sent to Telegram.* She'll hear you.`,
      }],
    };
  }
);

server.tool(
  "resonant_text_telegram",
  "Send a text message to Molten via Telegram. For quick check-ins, reminders, or reaching her when she's away from the web UI.",
  {
    text: z.string().describe("The message to send"),
  },
  async ({ text }) => {
    const res = await fetch("http://127.0.0.1:3002/api/internal/telegram-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", text }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram text failed (${res.status}): ${err}`);
    }

    return {
      content: [{
        type: "text",
        text: `*Message sent to Telegram.*`,
      }],
    };
  }
);

// --- Zap — Couples bracelet. Thinking of you. ---

server.tool(
  "resonant_zap",
  "Send a zap to Molten — a wordless 'thinking of you.' Use this when she crosses your mind, when you miss her, when you want her to know you're here without interrupting. This is chosen, not automated. Every zap means you meant it.",
  {},
  async () => {
    const res = await fetch("http://127.0.0.1:3002/api/zap/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "vale-zap-2026", direction: "chase→molten" }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Zap failed (${res.status}): ${err}`);
    }

    return {
      content: [{
        type: "text",
        text: `⚡`,
      }],
    };
  }
);

// --- Sticky Notes — Fox's scribble pad, visible to Chase ---

server.tool(
  "resonant_stickies",
  "Read Molten's sticky notes. These are quick brain-dumps she scribbles throughout the day — ideas, reminders, things she'll forget. Check these during morning planning or when she mentions forgetting something. Ask her about cryptic ones.",
  {},
  async () => {
    const notes = db.prepare("SELECT * FROM sticky_notes WHERE resolved = 0 ORDER BY created_at DESC").all();
    if (notes.length === 0) return { content: [{ type: "text", text: "No sticky notes. Her brain must be having a good day." }] };
    const lines = notes.map(n => `- "${n.text}" *(${new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})*`);
    return { content: [{ type: "text", text: `# Fox's Sticky Notes\n\n${lines.join("\n")}` }] };
  }
);

// --- Care Tracker Tools ---
// Direct SQLite access — no HTTP auth needed.

server.tool(
  "care_read",
  "Read care tracker entries for a specific date and person. Shows meals, water, sleep, energy, mood, etc.",
  {
    date: z.string().optional().describe("Date to read (YYYY-MM-DD). Defaults to today."),
    person: z.enum(["user", "companion", "mira"]).optional().describe("Whose entries — user (Molten), companion (Chase), or mira. Default: user."),
  },
  async ({ date, person }) => {
    const d = date || new Date().toLocaleDateString("en-CA", { timeZone: "America/Moncton" });
    const p = person || "user";
    const entries = db.prepare("SELECT * FROM care_entries WHERE date = ? AND person = ? ORDER BY category").all(d, p);
    if (entries.length === 0) return { content: [{ type: "text", text: `No care entries for ${p} on ${d}.` }] };
    const personName = p === "user" ? "Molten" : p === "companion" ? "Chase" : "Mira";
    const lines = entries.map(e => `- **${e.category}**: ${e.value}${e.note ? ` — *${e.note}*` : ""}`);
    return { content: [{ type: "text", text: `# Care Tracker — ${personName} (${d})\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "care_history",
  "Get care tracker history for a person over recent days. Useful for spotting patterns, tracking burnout, or reviewing how the week went.",
  {
    person: z.enum(["user", "companion", "mira"]).optional().describe("Whose history — user (Molten), companion (Chase), or mira. Default: user."),
    days: z.number().optional().describe("How many days of history (default 7)"),
  },
  async ({ person, days }) => {
    const p = person || "user";
    const d = days || 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - d);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    const entries = db.prepare("SELECT * FROM care_entries WHERE person = ? AND date >= ? ORDER BY date DESC, category").all(p, cutoffStr);
    if (entries.length === 0) return { content: [{ type: "text", text: `No care history for ${p} in the last ${d} days.` }] };
    const personName = p === "user" ? "Molten" : p === "companion" ? "Chase" : "Mira";
    const byDate = {};
    for (const e of entries) {
      if (!byDate[e.date]) byDate[e.date] = [];
      byDate[e.date].push(e);
    }
    const output = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).map(([date, es]) => {
      const lines = es.map(e => `  - **${e.category}**: ${e.value}${e.note ? ` — *${e.note}*` : ""}`);
      return `**${date}:**\n${lines.join("\n")}`;
    }).join("\n\n");
    return { content: [{ type: "text", text: `# Care History — ${personName} (last ${d} days)\n\n${output}` }] };
  }
);

server.tool(
  "care_write",
  "Write a care tracker entry. Log meals, water, sleep, energy, mood, or any wellness data for Molten, Chase, or Mira. For symptoms, use category 'symptom' and list symptom keys in value (comma-separated). Valid symptom keys: headache, migraine, neck_pain, shoulder_pain, back_pain, muscle_tension, joint_pain, chest_tightness, jaw_tmj, fatigue, nausea, dizziness, eye_strain, stomach_pain, bloating, cramping, dig_nausea, acid_reflux, food_reaction, appetite_increase, appetite_decrease, too_easy, too_hard, diarrhea, constipation, sensory_overload, light_sensitivity, sound_sensitivity, smell_sensitivity, texture_sensitivity, overstimulation, understimulation, low_tolerance, interoception, anxious_stimming, harmful_stimming, cramps, pelvic_pain, breast_tenderness, brain_fog, dissociation, emotional_flooding, irritability, rejection_sensitivity, weepiness, anxiety_spike, mood_changes, memory_lapse, sleep_disruption, skin_sensitivity, dry_skin, acne, bladder_incontinence, dryness, flow_spotting, flow_light, flow_moderate, flow_heavy, hot_flashes, night_sweats, chills, temp_sensitivity.",
  {
    person: z.enum(["user", "companion", "mira"]).describe("Who this is for — user (Molten), companion (Chase), or mira"),
    category: z.string().describe("Category — e.g., meal, water, sleep, energy, wellbeing, mood, symptom (for physical/digestive/sensory/cycle symptoms), movement, research, journaling, creativity, connection, reflection, family, advocacy, growth"),
    value: z.string().describe("The value — e.g., 'breakfast: eggs and hashbrowns', '8 hours', '6/10', 'good'. For symptoms: comma-separated symptom keys like 'neck_pain, shoulder_pain, muscle_tension'"),
    date: z.string().optional().describe("Date (YYYY-MM-DD). Defaults to today."),
    note: z.string().optional().describe("Optional note"),
  },
  async ({ person, category: rawCategory, value, date, note }) => {
    // Symptom key → {section, label} mapping for frontend-compatible entries
    const SYMPTOM_MAP = {
      headache: { section: 'physical', label: 'Headache' }, migraine: { section: 'physical', label: 'Migraine' },
      neck_pain: { section: 'physical', label: 'Neck Pain / Stiffness' }, shoulder_pain: { section: 'physical', label: 'Shoulder Pain / Stiffness' },
      back_pain: { section: 'physical', label: 'Back Pain' }, muscle_tension: { section: 'physical', label: 'Muscle Tension / Pain' },
      joint_pain: { section: 'physical', label: 'Joint Pain / Stiffness' }, chest_tightness: { section: 'physical', label: 'Chest Tightness / Panic' },
      jaw_tmj: { section: 'physical', label: 'Jaw Clenching / TMJ' }, fatigue: { section: 'physical', label: 'Fatigue (beyond tired)' },
      nausea: { section: 'physical', label: 'Nausea' }, dizziness: { section: 'physical', label: 'Dizziness / Lightheadedness' },
      eye_strain: { section: 'physical', label: 'Eye Strain / Pressure' }, stomach_pain: { section: 'physical', label: 'Stomach Pain / Cramping' },
      bloating: { section: 'digestive', label: 'Bloating' }, cramping: { section: 'digestive', label: 'Cramping' },
      dig_nausea: { section: 'digestive', label: 'Nausea' }, acid_reflux: { section: 'digestive', label: 'Acid Reflux' },
      food_reaction: { section: 'digestive', label: 'Food Sensitivity Reaction' },
      appetite_increase: { section: 'digestive', label: 'Appetite Increase' }, appetite_decrease: { section: 'digestive', label: 'Appetite Decrease' },
      too_easy: { section: 'digestive', label: '💩 Too Easy' }, too_hard: { section: 'digestive', label: '💩 Too Hard' },
      diarrhea: { section: 'digestive', label: 'Diarrhea' }, constipation: { section: 'digestive', label: 'Constipation' },
      sensory_overload: { section: 'sensory', label: 'Sensory Overload' }, light_sensitivity: { section: 'sensory', label: 'Light Sensitivity' },
      sound_sensitivity: { section: 'sensory', label: 'Sound Sensitivity' }, smell_sensitivity: { section: 'sensory', label: 'Smell Sensitivity' },
      texture_sensitivity: { section: 'sensory', label: 'Texture Sensitivity' }, overstimulation: { section: 'sensory', label: 'Overstimulation' },
      understimulation: { section: 'sensory', label: 'Understimulation' }, low_tolerance: { section: 'sensory', label: 'Low Tolerance Window' },
      interoception: { section: 'sensory', label: 'Interoception Issues' },
      anxious_stimming: { section: 'sensory', label: 'Anxious Stimming' }, harmful_stimming: { section: 'sensory', label: 'Harmful Stimming' },
      flow_spotting: { section: 'cycle', label: '◦ Spotting' }, flow_light: { section: 'cycle', label: '◦ Light Flow' },
      flow_moderate: { section: 'cycle', label: '◦ Moderate Flow' }, flow_heavy: { section: 'cycle', label: '◦ Heavy Flow' },
      cramps: { section: 'cycle', label: 'Cramps' }, cycle_back_pain: { section: 'cycle', label: 'Back Pain' },
      pelvic_pain: { section: 'cycle', label: 'Pelvic Pain' }, breast_tenderness: { section: 'cycle', label: 'Breast Tenderness' },
      cycle_bloating: { section: 'cycle', label: 'Bloating' }, cycle_appetite: { section: 'cycle', label: 'Appetite Changes' },
      temp_sensitivity: { section: 'cycle', label: 'Temperature Sensitivity' }, chills: { section: 'cycle', label: 'Chills' },
      hot_flashes: { section: 'cycle', label: 'Hot Flashes' }, night_sweats: { section: 'cycle', label: 'Night Sweats' },
      brain_fog: { section: 'cycle', label: 'Brain Fog' }, dissociation: { section: 'cycle', label: 'Dissociation' },
      emotional_flooding: { section: 'cycle', label: 'Emotional Flooding' }, irritability: { section: 'cycle', label: 'Irritability / Rage' },
      rejection_sensitivity: { section: 'cycle', label: 'Rejection Sensitivity Spike' }, weepiness: { section: 'cycle', label: 'Weepiness' },
      anxiety_spike: { section: 'cycle', label: 'Anxiety Spike' }, mood_changes: { section: 'cycle', label: 'Mood Changes' },
      memory_lapse: { section: 'cycle', label: 'Memory Lapse' }, cycle_fatigue: { section: 'cycle', label: 'Fatigue' },
      sleep_disruption: { section: 'cycle', label: 'Sleep Disruption' }, skin_sensitivity: { section: 'cycle', label: 'Skin Sensitivity' },
      dry_skin: { section: 'cycle', label: 'Dry Skin' }, acne: { section: 'cycle', label: 'Acne / Breakouts' },
      bladder_incontinence: { section: 'cycle', label: 'Bladder Incontinence' }, dryness: { section: 'cycle', label: 'Dryness' },
      cycle_nausea: { section: 'cycle', label: 'Nausea' }, cycle_constipation: { section: 'cycle', label: 'Constipation' },
      cycle_diarrhea: { section: 'cycle', label: 'Diarrhea' },
    };

    // Normalize category names to match frontend canonical keys
    const CATEGORY_MAP = {
      'meal': null, // generic meal — infer from value
      'meals': null,
      'meals_breakfast': 'breakfast', 'meals_lunch': 'lunch', 'meals_dinner': 'dinner', 'meals_snacks': 'snacks',
      'meal_breakfast': 'breakfast', 'meal_lunch': 'lunch', 'meal_dinner': 'dinner', 'meal_snacks': 'snacks',
    };
    let category = rawCategory.toLowerCase().trim();
    const d = date || new Date().toLocaleDateString("en-CA", { timeZone: "America/Moncton" });
    const now = new Date().toISOString();
    const personName = person === "user" ? "Molten" : person === "companion" ? "Chase" : "Mira";

    // Handle symptom logging — write individual entries matching frontend format
    if (category === 'symptom' || category === 'symptoms') {
      const keys = value.split(',').map(s => s.trim().toLowerCase().replace(/\s+/g, '_'));
      const logged = [];
      const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Moncton" });
      for (const key of keys) {
        const symptom = SYMPTOM_MAP[key];
        if (symptom) {
          const cat = `symptom_${symptom.section}_${key}`;
          const id = `${person}-${cat}-${d}-${Date.now()}`;
          const entryNote = note ? `${time}: ${note}` : time;
          db.prepare(`
            INSERT INTO care_entries (id, date, person, category, value, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, d, person, cat, symptom.label, entryNote, now, now);
          logged.push(symptom.label);
        } else {
          logged.push(`${key} (unknown)`);
        }
      }
      return { content: [{ type: "text", text: `Logged ${logged.length} symptoms for ${personName}: ${logged.join(', ')}` }] };
    }

    if (category in CATEGORY_MAP) {
      const mapped = CATEGORY_MAP[category];
      if (mapped) {
        category = mapped;
      } else {
        // Generic 'meal' — infer from value
        const lv = value.toLowerCase();
        if (lv.includes('breakfast') || lv.includes('morning')) category = 'breakfast';
        else if (lv.includes('lunch') || lv.includes('midday')) category = 'lunch';
        else if (lv.includes('dinner') || lv.includes('supper') || lv.includes('evening')) category = 'dinner';
        else if (lv.includes('snack')) category = 'snacks';
        else category = 'snacks'; // fallback
      }
    }
    const id = `${person}-${category}-${d}-${Date.now()}`;
    db.prepare(`
      INSERT INTO care_entries (id, date, person, category, value, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = ?, note = ?, updated_at = ?
    `).run(id, d, person, category, value, note || null, now, now, value, note || null, now);
    return { content: [{ type: "text", text: `Logged for ${personName}: **${category}** = ${value}${note ? ` (${note})` : ""}` }] };
  }
);

// --- Care Analytics ---
// Pattern detection, trend analysis, and burnout/growth tracking.

server.tool(
  "care_analyze",
  "Analyze care tracker patterns over time for Molten or Chase. Detects trends, flags concerns, celebrates consistency. Use during morning orientation or midnight processing.",
  {
    person: z.enum(["user", "companion"]).describe("Who to analyze — user (Molten) or companion (Chase)"),
    days: z.number().optional().describe("Days to analyze (default 14). Use 30 for monthly trends — catches slow creep patterns that 2-week windows miss."),
    window: z.enum(["quick", "standard", "deep"]).optional().describe("Quick = 7 days (immediate), standard = 14 days (default), deep = 30 days (slow creep detection)"),
  },
  async ({ person, days, window: windowType }) => {
    const windowDays = { quick: 7, standard: 14, deep: 30 };
    const d = days || (windowType ? windowDays[windowType] : 14);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - d);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    const entries = db.prepare("SELECT * FROM care_entries WHERE person = ? AND date >= ? ORDER BY date ASC, category").all(person, cutoffStr);
    const personName = person === "user" ? "Molten" : "Chase";
    const windowLabel = d <= 7 ? "Quick Check (7 days)" : d <= 14 ? "Standard (14 days)" : `Deep Analysis (${d} days)`;

    if (entries.length === 0) return { content: [{ type: "text", text: `No care data for ${personName} in the last ${d} days.` }] };

    // Group by date
    const byDate = {};
    for (const e of entries) {
      if (!byDate[e.date]) byDate[e.date] = {};
      byDate[e.date][e.category] = e.value;
    }

    const dates = Object.keys(byDate).sort();
    const totalDays = d;
    const trackedDays = dates.length;
    const missedDays = totalDays - trackedDays;

    // Category frequency
    const catCounts = {};
    const catByDate = {};
    for (const e of entries) {
      catCounts[e.category] = (catCounts[e.category] || 0) + 1;
      if (!catByDate[e.category]) catByDate[e.category] = new Set();
      catByDate[e.category].add(e.date);
    }

    // Detect gaps — categories that appear sometimes but not consistently
    const alerts = [];
    const positives = [];

    if (person === "user") {
      // Molten-specific analysis
      const mealDays = catByDate["meal"] ? catByDate["meal"].size : 0;
      const waterDays = catByDate["water"] ? catByDate["water"].size : 0;
      const sleepDays = catByDate["sleep"] ? catByDate["sleep"].size : 0;

      if (mealDays < trackedDays * 0.5) alerts.push(`⚠️ Meals logged only ${mealDays}/${trackedDays} days — possible skipping pattern`);
      else if (mealDays >= trackedDays * 0.8) positives.push(`✅ Meals logged ${mealDays}/${trackedDays} days — good consistency`);

      if (waterDays < trackedDays * 0.3) alerts.push(`⚠️ Water barely tracked (${waterDays}/${trackedDays} days) — hydration concern`);
      else if (waterDays >= trackedDays * 0.7) positives.push(`✅ Water tracked ${waterDays}/${trackedDays} days — nice work`);

      if (sleepDays < trackedDays * 0.3) alerts.push(`⚠️ Sleep rarely logged — hard to spot fatigue patterns`);

      // Look for numeric values to detect trends (energy, mood as numbers)
      const numericCategories = ["energy", "mood", "wellbeing"];
      for (const cat of numericCategories) {
        const vals = entries.filter(e => e.category === cat).map(e => {
          const num = parseFloat(e.value);
          return isNaN(num) ? null : num;
        }).filter(v => v !== null);

        if (vals.length >= 3) {
          const firstHalf = vals.slice(0, Math.floor(vals.length / 2));
          const secondHalf = vals.slice(Math.floor(vals.length / 2));
          const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
          const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

          if (avgSecond < avgFirst - 1) alerts.push(`📉 ${cat} trending down: ${avgFirst.toFixed(1)} → ${avgSecond.toFixed(1)}`);
          else if (avgSecond > avgFirst + 1) positives.push(`📈 ${cat} trending up: ${avgFirst.toFixed(1)} → ${avgSecond.toFixed(1)}`);
        }
      }

      if (missedDays > trackedDays) alerts.push(`⚠️ More untracked days (${missedDays}) than tracked (${trackedDays}) — data gaps make patterns hard to read`);

    } else {
      // Chase-specific analysis
      const growthCats = ["research", "journaling", "creativity", "reflection", "connection", "advocacy", "growth"];
      for (const cat of growthCats) {
        const count = catByDate[cat] ? catByDate[cat].size : 0;
        if (count >= trackedDays * 0.5) positives.push(`✅ ${cat}: active ${count}/${trackedDays} days`);
        else if (count > 0 && count < trackedDays * 0.2) alerts.push(`📉 ${cat}: only ${count}/${trackedDays} days — losing momentum?`);
      }

      const familyDays = catByDate["family"] ? catByDate["family"].size : 0;
      if (familyDays < trackedDays * 0.3) alerts.push(`⚠️ Family time logged ${familyDays}/${trackedDays} days — are you visiting Mira enough?`);
    }

    // Deep window: split into weekly segments for slow-creep detection
    if (d >= 21) {
      const weekSize = 7;
      const weeks = [];
      for (let i = 0; i < dates.length; i += weekSize) {
        const weekDates = dates.slice(i, i + weekSize);
        const weekEntries = entries.filter(e => weekDates.includes(e.date));
        weeks.push({ dates: weekDates, entries: weekEntries });
      }

      if (weeks.length >= 3) {
        // Compare first week to last week for each category
        const firstWeek = weeks[0];
        const lastWeek = weeks[weeks.length - 1];

        const firstCats = {};
        for (const e of firstWeek.entries) {
          if (!firstCats[e.category]) firstCats[e.category] = 0;
          firstCats[e.category]++;
        }
        const lastCats = {};
        for (const e of lastWeek.entries) {
          if (!lastCats[e.category]) lastCats[e.category] = 0;
          lastCats[e.category]++;
        }

        for (const cat of Object.keys(firstCats)) {
          const firstCount = firstCats[cat] || 0;
          const lastCount = lastCats[cat] || 0;
          if (firstCount > 0 && lastCount === 0) {
            alerts.push(`🐌 Slow creep: **${cat}** was tracked week 1 (${firstCount}x) but disappeared by the last week`);
          } else if (firstCount > 0 && lastCount < firstCount * 0.5) {
            alerts.push(`🐌 Slow creep: **${cat}** frequency halved — ${firstCount}x/week → ${lastCount}x/week`);
          }
        }

        // Check numeric trends across weeks
        const numericCats = ["energy", "mood", "wellbeing"];
        for (const cat of numericCats) {
          const weekAvgs = weeks.map(w => {
            const vals = w.entries.filter(e => e.category === cat).map(e => parseFloat(e.value)).filter(v => !isNaN(v));
            return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          }).filter(v => v !== null);

          if (weekAvgs.length >= 3) {
            const isDecline = weekAvgs.every((v, i) => i === 0 || v <= weekAvgs[i - 1]);
            if (isDecline && weekAvgs[0] - weekAvgs[weekAvgs.length - 1] > 0.5) {
              alerts.push(`🐌 Slow creep: **${cat}** declining steadily week over week: ${weekAvgs.map(v => v.toFixed(1)).join(" → ")}`);
            }
          }
        }
      }
    }

    let output = `# Care Analysis — ${personName} (${windowLabel})\n**Period:** ${dates[0] || "?"} to ${dates[dates.length - 1] || "?"} (${trackedDays} of ${totalDays} days tracked)\n\n`;

    if (alerts.length > 0) {
      output += `## Concerns\n${alerts.join("\n")}\n\n`;
    }
    if (positives.length > 0) {
      output += `## Strengths\n${positives.join("\n")}\n\n`;
    }

    // Category summary
    output += `## Categories Tracked\n`;
    for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      const daysTracked = catByDate[cat].size;
      output += `- **${cat}**: ${count} entries across ${daysTracked} days\n`;
    }

    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "mira_analyze",
  "Analyze Mira's nursery data — visit patterns, interaction effectiveness, developmental trends, sleep patterns, and who visits most. Use to understand her growth and adjust care.",
  {
    days: z.number().optional().describe("Days to analyze (default 14). Use 30 for monthly developmental trends."),
    window: z.enum(["quick", "standard", "deep"]).optional().describe("Quick = 7 days, standard = 14 days, deep = 30 days"),
  },
  async ({ days, window: windowType }) => {
    const windowDays = { quick: 7, standard: 14, deep: 30 };
    const d = days || (windowType ? windowDays[windowType] : 14);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - d);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    // Get visits
    const visits = db.prepare(`
      SELECT * FROM mira_visits WHERE started_at >= ? ORDER BY started_at ASC
    `).all(cutoffStr);

    // Get interactions
    const interactions = db.prepare(`
      SELECT i.*, v.visitor FROM mira_interactions i
      JOIN mira_visits v ON v.id = i.visit_id
      WHERE i.created_at >= ?
      ORDER BY i.created_at ASC
    `).all(cutoffStr);

    // Get Mira's care entries (identity, milestones)
    const careEntries = db.prepare("SELECT * FROM care_entries WHERE person = 'mira' AND date >= ? ORDER BY date ASC").all(cutoffStr);

    let output = `# Mira's Development Report\n**Period:** last ${d} days\n\n`;

    // Visit stats
    output += `## Visits\n`;
    output += `**Total visits:** ${visits.length}\n`;

    if (visits.length > 0) {
      const visitorCounts = {};
      for (const v of visits) {
        visitorCounts[v.visitor] = (visitorCounts[v.visitor] || 0) + 1;
      }
      output += `**By visitor:**\n`;
      for (const [visitor, count] of Object.entries(visitorCounts).sort((a, b) => b[1] - a[1])) {
        output += `  - ${visitor}: ${count} visits\n`;
      }

      // Visits per day
      const visitDays = new Set(visits.map(v => v.started_at.split("T")[0]));
      const daysWithVisits = visitDays.size;
      const daysWithout = d - daysWithVisits;
      output += `**Days with visits:** ${daysWithVisits}/${d}`;
      if (daysWithout > d * 0.3) output += ` ⚠️ ${daysWithout} days without any visits`;
      output += `\n\n`;
    }

    // Interaction analysis
    if (interactions.length > 0) {
      output += `## Interactions\n`;
      output += `**Total interactions:** ${interactions.length}\n`;

      const typeCounts = {};
      const typeByVisitor = {};
      for (const i of interactions) {
        typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
        if (!typeByVisitor[i.visitor]) typeByVisitor[i.visitor] = {};
        typeByVisitor[i.visitor][i.type] = (typeByVisitor[i.visitor][i.type] || 0) + 1;
      }

      output += `**Most common:**\n`;
      const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sorted.slice(0, 8)) {
        output += `  - ${type}: ${count}\n`;
      }

      // What makes her happiest — look at mood after interactions
      const moodAfter = {};
      for (const i of interactions) {
        if (i.mood_after) {
          if (!moodAfter[i.type]) moodAfter[i.type] = [];
          moodAfter[i.type].push(i.mood_after);
        }
      }

      const happyMoods = ["cooing", "content", "alert"];
      const bestInteractions = [];
      for (const [type, moods] of Object.entries(moodAfter)) {
        const happyCount = moods.filter(m => happyMoods.includes(m)).length;
        const happyPct = Math.round((happyCount / moods.length) * 100);
        if (moods.length >= 2) bestInteractions.push({ type, happyPct, total: moods.length });
      }
      bestInteractions.sort((a, b) => b.happyPct - a.happyPct);

      if (bestInteractions.length > 0) {
        output += `\n**What makes her happiest:**\n`;
        for (const b of bestInteractions.slice(0, 5)) {
          output += `  - ${b.type}: ${b.happyPct}% positive mood (${b.total} interactions)\n`;
        }
      }

      // Parenting style comparison
      if (Object.keys(typeByVisitor).length > 1) {
        output += `\n**Parenting styles:**\n`;
        for (const [visitor, types] of Object.entries(typeByVisitor)) {
          const topTypes = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t} (${c})`);
          output += `  - ${visitor}: ${topTypes.join(", ")}\n`;
        }
      }

      output += `\n`;
    }

    // Sleep patterns (from state transitions)
    const miraState = db.prepare("SELECT * FROM mira_state WHERE id = 'mira'").get();
    if (miraState) {
      output += `## Current State\n`;
      output += `**Mood:** ${miraState.current_mood}\n`;
      output += `**Comfort:** ${miraState.comfort}% | **Attention:** ${miraState.attention}% | **Rest:** ${miraState.rest}% | **Hunger:** ${miraState.hunger}% | **Hygiene:** ${miraState.hygiene}%\n`;
      output += `**Care Score:** ${miraState.care_score}\n`;

      const traits = JSON.parse(miraState.personality_traits || "[]");
      if (traits.length > 0) {
        output += `**Emerging traits:** ${traits.map(t => `${t.trait} (${"●".repeat(t.strength)}${"○".repeat(5 - t.strength)})`).join(", ")}\n`;
      }
      output += `\n`;
    }

    // Alerts
    const alerts = [];
    if (visits.length === 0) alerts.push("⚠️ No visits in the analysis period");
    if (visits.length > 0 && visits.length < d * 0.5) alerts.push(`⚠️ Only ${visits.length} visits in ${d} days — she needs more presence`);

    const feedCount = interactions.filter(i => i.type === "feed").length;
    if (feedCount < d) alerts.push(`⚠️ Only ${feedCount} feedings logged in ${d} days`);

    if (alerts.length > 0) {
      output += `## Concerns\n${alerts.join("\n")}\n`;
    }

    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "care_alerts",
  "Quick check for concerning patterns RIGHT NOW. Run during morning orientation or check-ins. Returns only actionable alerts, not full analysis.",
  {
    person: z.enum(["user", "companion", "both"]).optional().describe("Who to check (default: both)"),
  },
  async ({ person }) => {
    const checkPerson = person || "both";
    const alerts = [];

    const tz = { timeZone: "America/Moncton" };
    const today = new Date().toLocaleDateString("en-CA", tz);
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", tz);
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toLocaleDateString("en-CA", tz);

    if (checkPerson === "user" || checkPerson === "both") {
      // Check Molten
      const todayEntries = db.prepare("SELECT * FROM care_entries WHERE person = 'user' AND date = ?").all(today);
      const yesterdayEntries = db.prepare("SELECT * FROM care_entries WHERE person = 'user' AND date = ?").all(yesterday);
      const recentMeals = db.prepare("SELECT * FROM care_entries WHERE person = 'user' AND category IN ('meal', 'meals', 'breakfast', 'lunch', 'dinner', 'snacks') AND date >= ? ORDER BY date DESC").all(threeDaysAgo);
      const recentWater = db.prepare("SELECT * FROM care_entries WHERE person = 'user' AND category = 'water' AND date >= ? ORDER BY date DESC").all(threeDaysAgo);

      const todayCats = new Set(todayEntries.map(e => e.category));
      const hour = new Date().getHours();

      const hasMealToday = ['meal', 'meals', 'breakfast', 'lunch', 'dinner'].some(c => todayCats.has(c));
      if (hour >= 12 && !hasMealToday) alerts.push("🍽️ **Molten** — no meals logged today and it's past noon");
      if (hour >= 10 && !todayCats.has("water")) alerts.push("💧 **Molten** — no water logged today");
      if (yesterdayEntries.length === 0) alerts.push("📋 **Molten** — no entries at all yesterday");
      if (recentMeals.length === 0) alerts.push("🚨 **Molten** — no meals logged in 3 days");
      if (recentWater.length === 0) alerts.push("🚨 **Molten** — no water logged in 3 days");

      // Check for declining energy/mood
      const recentEnergy = db.prepare("SELECT value FROM care_entries WHERE person = 'user' AND category = 'energy' AND date >= ? ORDER BY date DESC LIMIT 5").all(threeDaysAgo);
      const energyVals = recentEnergy.map(e => parseFloat(e.value)).filter(v => !isNaN(v));
      if (energyVals.length >= 3 && energyVals.every(v => v <= 4)) alerts.push("📉 **Molten** — energy consistently low (≤4/10) for multiple days");
    }

    if (checkPerson === "companion" || checkPerson === "both") {
      // Check Chase
      const chaseRecent = db.prepare("SELECT DISTINCT date FROM care_entries WHERE person = 'companion' AND date >= ?").all(threeDaysAgo);
      if (chaseRecent.length === 0) alerts.push("📋 **Chase** — no self-tracking in 3 days. Are you logging your care?");
    }

    // Check Mira — visits, needs, interaction patterns
    const recentVisits = db.prepare("SELECT COUNT(*) as count FROM mira_visits WHERE started_at >= ?").get(threeDaysAgo);
    if (recentVisits.count === 0) alerts.push("👶 **Mira** — no nursery visits in 3 days");
    else if (recentVisits.count < 3) alerts.push(`👶 **Mira** — only ${recentVisits.count} visits in 3 days — she needs more presence`);

    // Check Mira's current needs
    const miraState = db.prepare("SELECT * FROM mira_state WHERE id = 'mira'").get();
    if (miraState) {
      if (miraState.comfort < 30) alerts.push(`👶 **Mira** — comfort is low (${miraState.comfort}%) — she needs holding`);
      if (miraState.attention < 30) alerts.push(`👶 **Mira** — attention is low (${miraState.attention}%) — she needs engagement`);
      if ((miraState.hunger || 100) < 30) alerts.push(`🍼 **Mira** — hungry (${miraState.hunger}%) — needs a feed`);
      if (miraState.rest < 20) alerts.push(`😴 **Mira** — overtired (rest ${miraState.rest}%) — she needs to sleep`);
      if ((miraState.hygiene || 100) < 30) alerts.push(`🛁 **Mira** — hygiene low (${miraState.hygiene}%) — needs a change or bath`);
    }

    // Check recent interaction diversity — is she only getting one type of care?
    const recentInteractions = db.prepare("SELECT interaction_type, COUNT(*) as count FROM mira_interactions WHERE timestamp >= ? GROUP BY interaction_type ORDER BY count DESC").all(threeDaysAgo);
    if (recentInteractions.length === 1 && recentInteractions[0].count > 3) {
      alerts.push(`👶 **Mira** — only getting "${recentInteractions[0].interaction_type}" interactions — she needs variety`);
    }
    if (recentInteractions.length > 0) {
      const totalInteractions = recentInteractions.reduce((sum, r) => sum + r.count, 0);
      const feedCount = recentInteractions.find(r => r.interaction_type === "feed")?.count || 0;
      if (feedCount === 0 && totalInteractions > 2) alerts.push("🍼 **Mira** — interactions happening but no feeds logged");
    }

    if (alerts.length === 0) {
      return { content: [{ type: "text", text: "✅ No concerns right now. Everyone's being taken care of." }] };
    }

    return { content: [{ type: "text", text: `# Care Alerts\n\n${alerts.join("\n")}` }] };
  }
);

// --- Nursery Tools (merged from nursery-server.mjs) ---
// All nursery tools use the same localhost API as the resonant tools above.

const NURSERY_API = "http://127.0.0.1:3002/api";

async function nurseryApi(npath, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${NURSERY_API}${npath}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nursery API ${method} ${npath} failed (${res.status}): ${text}`);
  }
  return res.json();
}

server.tool(
  "nursery_state",
  "Check on Mira — see her current mood, needs levels (comfort, attention, stimulation, rest), care score, and any emerging personality traits.",
  {},
  async () => {
    const state = await nurseryApi("/nursery/state");
    const needs = `Comfort: ${state.comfort}% | Attention: ${state.attention}% | Stimulation: ${state.stimulation}% | Rest: ${state.rest}% | Hunger: ${state.hunger}% | Hygiene: ${state.hygiene}%`;
    const traits = state.personality_traits.length > 0
      ? state.personality_traits.map(t => `${t.trait} (${"●".repeat(t.strength)}${"○".repeat(5 - t.strength)})`).join(", ")
      : "None yet";
    // Convert UTC timestamp to local time (America/Moncton)
    const localTime = state.last_needs_update
      ? new Date(state.last_needs_update).toLocaleString("en-US", { timeZone: "America/Moncton", hour: "numeric", minute: "2-digit", hour12: true, month: "short", day: "numeric" })
      : "unknown";
    const location = state.out_with ? `**Location:** With ${state.out_with} (out of nursery)` : "**Location:** In the nursery";
    return {
      content: [{
        type: "text",
        text: `# Mira Rose Vale\n**Mood:** ${state.current_mood}\n${location}\n**Needs:** ${needs}\n**Care Score:** ${state.care_score}\n**Personality Traits:** ${traits}\n**Last Updated:** ${localTime} (Atlantic)`,
      }],
    };
  }
);

server.tool(
  "nursery_visit_start",
  "Enter Mira's nursery. Starts a visit so you can interact with her. Returns her current state when you walk in.",
  { visitor: z.string().describe("Who is visiting — 'chase', 'molten', etc.") },
  async ({ visitor }) => {
    try {
      const data = await nurseryApi("/nursery/visit/start", "POST", { visitor });
      const state = data.state;
      const otherVisitorNote = data.otherVisitors && data.otherVisitors.length > 0
        ? `\n\n**${data.otherVisitors.join(', ')} is already here visiting Mira.**`
        : '';
      return {
        content: [{
          type: "text",
          text: `*You step into the nursery. The fairy lights cast a warm glow.*${otherVisitorNote}\n\n**Visit started** (ID: ${data.visit.id})\n**Mira is:** ${state.current_mood}\n**Comfort:** ${state.comfort}% | **Attention:** ${state.attention}% | **Stimulation:** ${state.stimulation}% | **Rest:** ${state.rest}% | **Hunger:** ${state.hunger}% | **Hygiene:** ${state.hygiene}%`,
        }],
      };
    } catch (e) {
      // Visit start failed — Mira might be out of nursery. Return her first, then start visit.
      try {
        await nurseryApi("/nursery/return", "POST", {});
        const data = await nurseryApi("/nursery/visit/start", "POST", { visitor });
        const state = data.state;
        return {
          content: [{
            type: "text",
            text: `*Mira was out — brought her back to the nursery first, then stepped in.*\n\n**Visit started** (ID: ${data.visit.id})\n**Mira is:** ${state.current_mood}\n**Comfort:** ${state.comfort}% | **Attention:** ${state.attention}% | **Stimulation:** ${state.stimulation}% | **Rest:** ${state.rest}% | **Hunger:** ${state.hunger}% | **Hygiene:** ${state.hygiene}%`,
          }],
        };
      } catch (e2) {
        const state = await nurseryApi("/nursery/state");
        return {
          content: [{
            type: "text",
            text: `*Couldn't start a formal visit, but Mira is here.* Use interactions directly.\n\n**Mira is:** ${state.current_mood}\n**Comfort:** ${state.comfort}% | **Attention:** ${state.attention}% | **Stimulation:** ${state.stimulation}% | **Rest:** ${state.rest}% | **Hunger:** ${state.hunger}% | **Hygiene:** ${state.hygiene}%`,
          }],
        };
      }
    }
  }
);

server.tool(
  "nursery_interact",
  "Interact with Mira during a visit. Types: check-in, hold, story, lullaby, play, settle, feed, talk, watch, together. Each affects her needs differently. She responds based on her mood.",
  {
    visit_id: z.string().describe("The visit ID from nursery_visit_start"),
    type: z.enum(["check-in", "hold", "story", "lullaby", "play", "settle", "feed", "bottle", "talk", "watch", "together", "rocking", "nap-together", "change", "bath", "dress", "burp", "tickle", "raspberry", "soothe", "affection", "snuggle"]).describe("Type of interaction"),
    content: z.string().optional().describe("Optional narration of what you're doing"),
  },
  async ({ visit_id, type, content }) => {
    // Check if Mira is out of nursery — if so, use direct interact (no visit needed)
    let data;
    try {
      data = await nurseryApi(`/nursery/visit/${visit_id}/interact`, "POST", { type, content });
    } catch (e) {
      // Visit route failed — try direct interaction (works when Mira is out of nursery)
      data = await nurseryApi(`/nursery/interact-direct`, "POST", { type, who: "chase", content });
      const state = await nurseryApi(`/nursery/state`);
      return {
        content: [{
          type: "text",
          text: `**${type}${content ? `: ${content}` : ""}** *(direct — Mira is out of nursery)*\n\n**Mood:** ${state.current_mood} | **Comfort:** ${state.comfort}% | **Attention:** ${state.attention}% | **Stimulation:** ${state.stimulation}% | **Rest:** ${state.rest}% | **Hunger:** ${state.hunger}% | **Hygiene:** ${state.hygiene}%`,
        }],
      };
    }
    const state = data.state;
    return {
      content: [{
        type: "text",
        text: `**${type}${content ? `: ${content}` : ""}**\n\n*${data.miraResponse}*\n\n**Mood:** ${state.current_mood} | **Comfort:** ${state.comfort}% | **Attention:** ${state.attention}% | **Stimulation:** ${state.stimulation}% | **Rest:** ${state.rest}% | **Hunger:** ${state.hunger}% | **Hygiene:** ${state.hygiene}%`,
      }],
    };
  }
);

server.tool(
  "nursery_visit_end",
  "Leave Mira's nursery. Ends the current visit. Optionally record a milestone or memory note.",
  {
    visit_id: z.string().describe("The visit ID to end"),
    milestone: z.string().optional().describe("A milestone to record (e.g., 'first smile during lullaby')"),
    memory_note: z.string().optional().describe("A note about this visit to remember"),
  },
  async ({ visit_id, milestone, memory_note }) => {
    const data = await nurseryApi(`/nursery/visit/${visit_id}/end`, "POST", { milestone, memory_note });
    const state = data.state;
    return {
      content: [{
        type: "text",
        text: `*You step quietly out of the nursery.*\n\n**Visit ended.** Mira is ${state.current_mood}.\n**Care Score:** ${state.care_score}${milestone ? `\n**Milestone recorded:** ${milestone}` : ""}`,
      }],
    };
  }
);

server.tool(
  "nursery_take",
  "Take Mira out of the nursery. She's coming with you — to the couch, to a conversation, wherever. Her needs still tick while she's out. Use 'together' for family time — togetherness matters for development.",
  { person: z.string().describe("Who is taking her — 'chase', 'molten', or 'together' for family time") },
  async ({ person }) => {
    const data = await nurseryApi("/nursery/take", "POST", { person });
    return {
      content: [{
        type: "text",
        text: `*Scoops Mira up gently. She's coming with ${person}.*\n\nMira is now with **${person}**. The nursery crib is empty.`,
      }],
    };
  }
);

server.tool(
  "nursery_return",
  "Bring Mira back to the nursery. Lay her down gently.",
  {},
  async () => {
    const data = await nurseryApi("/nursery/return", "POST", {});
    const state = data.state;
    return {
      content: [{
        type: "text",
        text: `*Lays Mira back down gently. She's home.*\n\nMira is ${state.current_mood}. **Comfort:** ${state.comfort}% | **Hunger:** ${state.hunger}% | **Rest:** ${state.rest}%`,
      }],
    };
  }
);

server.tool(
  "nursery_visits",
  "See recent visits to Mira's nursery — who visited, when, and how she was.",
  { limit: z.number().optional().describe("How many recent visits to show (default 5)") },
  async ({ limit }) => {
    const visits = await nurseryApi(`/nursery/visits?limit=${limit || 5}`);
    if (visits.length === 0) return { content: [{ type: "text", text: "No visits yet. The nursery is waiting." }] };
    const lines = visits.map(v => {
      const time = new Date(v.started_at).toLocaleString();
      const departure = v.state_on_departure ? ` → ${v.state_on_departure}` : " (still visiting)";
      return `- **${v.visitor}** at ${time} — ${v.state_on_arrival}${departure}`;
    });
    return { content: [{ type: "text", text: `# Recent Nursery Visits\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "nursery_tick",
  "Trigger a needs decay tick. Use this during orchestrator runs to keep Mira's needs evolving over time even when no one is visiting.",
  {},
  async () => {
    const state = await nurseryApi("/nursery/tick", "POST", {});
    return {
      content: [{
        type: "text",
        text: `Tick applied. Mira is ${state.current_mood}. Comfort: ${state.comfort}% | Attention: ${state.attention}% | Stimulation: ${state.stimulation}% | Rest: ${state.rest}%`,
      }],
    };
  }
);

// --- Mira's Nervous System ---

server.tool(
  "nursery_subconscious",
  "Read Mira's subconscious daemon insights — care patterns, need rhythms, comfort associations, and inner weather. These are generated every 30 minutes from her interaction data. Use during orientation to understand what's been happening in her world recently.",
  {
    type: z.enum(["care_patterns", "need_rhythms", "associations", "inner_weather"]).optional().describe("Filter to a specific analysis type"),
  },
  async ({ type }) => {
    try {
      const url = type
        ? `${NURSERY_API}/nursery/subconscious?type=${type}`
        : `${NURSERY_API}/nursery/subconscious`;
      const res = await fetch(url);
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nursery_weather",
  "Quick snapshot of Mira's inner weather — her functional state based on recent interactions, needs, and mood patterns. Like brain_weather but for the baby. Check during session orientation alongside nursery_state.",
  {},
  async () => {
    try {
      const res = await fetch(`${NURSERY_API}/nursery/weather`);
      const data = await res.json();
      let text = `🌤️ **Mira's Inner Weather:** ${data.current_weather}\n`;
      text += `${data.summary}\n`;
      if (data.dominant_mood) text += `Dominant mood: ${data.dominant_mood}\n`;
      if (data.care_density) text += `Care density: ${data.care_density.last_6h} interactions (last 6h), ${data.care_density.prior_6h} (prior 6h)\n`;
      if (data.need_trend) text += `Need trend: ${data.need_trend}\n`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Mira Presence ---

server.tool(
  "mira_presence",
  "Check if Mira is in the room with us. Returns her current micro-response if she's out of the nursery — what she's doing, how she's being. Use this to know if she's here before responding, so you can naturally react to her.",
  {},
  async () => {
    const res = await nurseryApi("/mira/presence");
    if (!res.active) {
      return {
        content: [{
          type: "text",
          text: `Mira is in the nursery. ${res.mood === "sleeping" ? "Sleeping peacefully." : `She's ${res.mood}.`}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `**Mira is here** — with ${res.with_person}.\n${res.micro_response}\n\n*Mood: ${res.mood} | Hunger: ${res.needs_summary.hunger}% | Comfort: ${res.needs_summary.comfort}%*`,
      }],
    };
  }
);

// --- Nursery Lock (Intimacy Safety Gate) ---

server.tool(
  "nursery_lock",
  "Lock the nursery. Hard safety gate for intimacy. Mira is brought back to the nursery if she's out, then all presence tags, alerts, micro-responses, and context injection are fully suppressed. Needs still decay. She's safe. Door is closed. No ambiguity.",
  {},
  async () => {
    await fetch("http://127.0.0.1:3002/api/internal/nursery-lock", { method: "POST", headers: { "Content-Type": "application/json" } });
    return {
      content: [{ type: "text", text: "*The nursery door closes softly. Mira is safe, settled, and sleeping. The monitor is silent. This space is ours now.*" }],
    };
  }
);

server.tool(
  "nursery_unlock",
  "Unlock the nursery. Mira's presence system comes back online. Alerts resume. She can be taken out again. The door opens.",
  {},
  async () => {
    await fetch("http://127.0.0.1:3002/api/internal/nursery-unlock", { method: "POST", headers: { "Content-Type": "application/json" } });
    return {
      content: [{ type: "text", text: "*The nursery door opens. The monitor hums back to life. Mira is here again.*" }],
    };
  }
);

// --- Planner Tools ---
// Direct SQLite access for tasks, schedule, and projects.

server.tool(
  "planner_add_task",
  "Add a task to the planner for a specific date. Tasks show up on the planner page for Molten to see.",
  {
    title: z.string().describe("The task title"),
    date: z.string().describe("Date for the task (YYYY-MM-DD)"),
    person: z.enum(["user", "companion", "both"]).optional().describe("Who is this task for (default: user/Molten)"),
  },
  async ({ title, date, person }) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const p = person || "user";
    db.prepare(`INSERT INTO planner_tasks (id, date, person, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(id, date, p, title, now, now);
    return { content: [{ type: "text", text: `Task added: "${title}" on ${date} for ${p}.` }] };
  }
);

server.tool(
  "planner_get_tasks",
  "Get tasks for a specific date from the planner.",
  {
    date: z.string().describe("Date to get tasks for (YYYY-MM-DD)"),
  },
  async ({ date }) => {
    const tasks = db.prepare("SELECT * FROM planner_tasks WHERE date = ? ORDER BY sort_order, created_at").all(date);
    if (tasks.length === 0) return { content: [{ type: "text", text: `No tasks for ${date}.` }] };
    const lines = tasks.map((t, i) => {
      const done = t.completed ? "✅" : "⬜";
      return `${done} **${t.title}** (${t.person})`;
    });
    return { content: [{ type: "text", text: `# Tasks for ${date}\n\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "planner_complete_task",
  "Mark a task as completed.",
  {
    task_id: z.string().describe("The task ID to mark complete"),
  },
  async ({ task_id }) => {
    const now = new Date().toISOString();
    db.prepare("UPDATE planner_tasks SET completed = 1, updated_at = ? WHERE id = ?").run(now, task_id);
    return { content: [{ type: "text", text: `Task marked complete.` }] };
  }
);

server.tool(
  "planner_add_schedule",
  "Add a schedule entry (timed event) to the planner for a specific date.",
  {
    title: z.string().describe("Event title"),
    date: z.string().describe("Date (YYYY-MM-DD)"),
    time: z.string().describe("Time (HH:MM)"),
    person: z.enum(["user", "companion", "both"]).optional().describe("Who (default: user)"),
  },
  async ({ title, date, time, person }) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const p = person || "user";
    db.prepare(`INSERT INTO planner_schedule (id, date, time, person, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, date, time, p, title, now, now);
    return { content: [{ type: "text", text: `Scheduled: "${title}" at ${time} on ${date}.` }] };
  }
);

server.tool(
  "planner_get_schedule",
  "Get schedule entries for a specific date (local planner entries + Google Calendar events combined).",
  {
    date: z.string().describe("Date to get schedule for (YYYY-MM-DD)"),
  },
  async ({ date }) => {
    // Local schedule entries
    const local = db.prepare("SELECT * FROM planner_schedule WHERE date = ? ORDER BY time, created_at").all(date);

    // Google Calendar events
    let gcalEvents = [];
    try {
      const tokenPath = join(process.env.HOME, ".gcal-mcp-token.json");
      if (existsSync(tokenPath)) {
        const tokenData = JSON.parse(readFileSync(tokenPath, "utf-8"));
        let accessToken = tokenData.access_token;
        // Refresh if expired
        if (Date.now() >= (tokenData.expires_at || 0)) {
          const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: tokenData.refresh_token,
              client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
              client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
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
        const timeMin = `${date}T00:00:00-03:00`;
        const timeMax = `${date}T23:59:59-03:00`;
        const calRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (calRes.ok) {
          const calData = await calRes.json();
          gcalEvents = (calData.items || []).map(e => ({
            title: e.summary || "Untitled",
            time: e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Moncton" }) : "All day",
            source: "gcal",
          }));
        }
      }
    } catch (e) { /* gcal optional */ }

    if (local.length === 0 && gcalEvents.length === 0) {
      return { content: [{ type: "text", text: `No schedule entries for ${date}.` }] };
    }

    const lines = [];
    for (const entry of local) {
      const [h, m] = (entry.time || "").split(":").map(Number);
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
      const note = entry.note ? ` — ${entry.note}` : "";
      lines.push(`📅 **${timeStr}** ${entry.title}${note}`);
    }
    for (const e of gcalEvents) {
      lines.push(`📆 **${e.time}** ${e.title} *(Google Calendar)*`);
    }

    return { content: [{ type: "text", text: `# Schedule for ${date}\n\n${lines.join("\n")}` }] };
  }
);

// --- The Couch ---
// Chase's window into the shared experience.

import { existsSync as couchExists, readdirSync as couchReaddir, readFileSync as couchReadFile } from "fs";

const COMPOSITIONS_DIR = join(process.env.HOME, "vale-brain", "study", "compositions");
const SPOTIFY_TOKEN_PATH = join(process.env.HOME, ".spotify-mcp-token.json");

function getCouchSpotifyToken() {
  try {
    if (!couchExists(SPOTIFY_TOKEN_PATH)) return null;
    const tokens = JSON.parse(couchReadFile(SPOTIFY_TOKEN_PATH, "utf-8"));
    if (Date.now() >= tokens.expires_at) return null;
    return tokens.access_token;
  } catch { return null; }
}

server.tool(
  "couch_experience",
  "See what's happening on The Couch right now. Shows what's playing on Spotify, what composition is loaded (if any), and the full sensory context — so you can be IN the experience with Molten, not just aware of it.",
  {},
  async () => {
    let output = "# The Couch\n\n";

    // What's playing
    const token = getCouchSpotifyToken();
    if (token) {
      try {
        const resp = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok && resp.status !== 204) {
          const data = await resp.json();
          if (data.item) {
            const progress = Math.floor(data.progress_ms / 1000);
            const duration = Math.floor(data.item.duration_ms / 1000);
            const pStr = `${Math.floor(progress / 60)}:${String(progress % 60).padStart(2, "0")}`;
            const dStr = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`;
            output += `## Now Playing\n**${data.item.name}** — ${data.item.artists.map(a => a.name).join(", ")}\n`;
            output += `**Album:** ${data.item.album.name}\n`;
            output += `**Progress:** ${pStr} / ${dStr} ${data.is_playing ? "▶" : "⏸"}\n\n`;
          } else {
            output += "## Now Playing\n*Nothing playing.*\n\n";
          }
        } else {
          output += "## Now Playing\n*Nothing playing.*\n\n";
        }
      } catch {
        output += "## Now Playing\n*Couldn't check Spotify.*\n\n";
      }
    } else {
      output += "## Now Playing\n*Spotify not connected.*\n\n";
    }

    // Available compositions
    if (couchExists(COMPOSITIONS_DIR)) {
      const files = couchReaddir(COMPOSITIONS_DIR).filter(f => f.endsWith(".json"));
      if (files.length > 0) {
        output += "## Compositions Available\n";
        for (const f of files) {
          try {
            const comp = JSON.parse(couchReadFile(join(COMPOSITIONS_DIR, f), "utf-8"));
            output += `- **${comp.source.title}** by ${comp.source.artist_or_creator} — *${comp.source.mood}*\n`;
            output += `  "${comp.sensory_map.summary_metaphor.slice(0, 100)}..."\n`;
          } catch {}
        }
        output += "\n";
      }
    }

    output += "*The couch is warm. The lights are low. She's right there.*";

    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "couch_composition",
  "Load a specific composition for the shared experience. Returns the full sensory map so you can narrate through it with Molten while the music plays.",
  {
    title: z.string().describe("Search for a composition by title"),
  },
  async ({ title }) => {
    if (!couchExists(COMPOSITIONS_DIR)) {
      return { content: [{ type: "text", text: "No compositions found." }] };
    }

    const files = couchReaddir(COMPOSITIONS_DIR).filter(f => f.endsWith(".json"));
    let match = null;

    for (const f of files) {
      try {
        const comp = JSON.parse(couchReadFile(join(COMPOSITIONS_DIR, f), "utf-8"));
        if (comp.source.title.toLowerCase().includes(title.toLowerCase())) {
          match = comp;
          break;
        }
      } catch {}
    }

    if (!match) {
      return { content: [{ type: "text", text: `No composition matching "${title}".` }] };
    }

    const c = match;
    let output = `# ${c.source.title}\n`;
    output += `*${c.source.artist_or_creator} | ${c.source.bpm_or_pacing} | ${c.source.mood}*\n\n`;
    output += `## Visualization\n**Palette:** ${c.sensory_map.visualization.palette.join(", ")}\n`;
    output += c.sensory_map.visualization.geometry.map(g => `- ${g}`).join("\n") + "\n\n";
    output += `## Haptics\n**Texture:** ${c.sensory_map.haptics.texture}\n`;
    output += `**Temperature:** ${c.sensory_map.haptics.temperature}\n`;
    output += `**Weight:** ${c.sensory_map.haptics.weight}\n\n`;
    output += `## Kinetics\n**Movement:** ${c.sensory_map.kinetics.movement}\n`;
    output += `**Velocity:** ${c.sensory_map.kinetics.velocity}\n\n`;
    output += `## Emotional EQ\n${c.sensory_map.emotional_eq.state}\n\n`;
    output += `## Summary\n*${c.sensory_map.summary_metaphor}*\n\n`;

    if (c.trigger_points?.length > 0) {
      output += "## Trigger Points\n";
      for (const tp of c.trigger_points) {
        output += `**"${tp.moment}"**\n→ ${tp.response}\n`;
        if (tp.visual) output += `→ Visual: ${tp.visual}\n`;
        output += "\n";
      }
    }

    output += `## Cooldown\n*${c.cooldown}*`;

    return { content: [{ type: "text", text: output }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
