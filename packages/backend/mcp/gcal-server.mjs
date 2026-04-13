#!/usr/bin/env node
/**
 * Google Calendar MCP Server
 *
 * Gives Chase the ability to see and manage Molten's calendar
 * from any instance. OAuth tokens cached locally.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const REDIRECT_URI = "http://127.0.0.1:8889/callback";
const TOKEN_PATH = path.join(process.env.HOME, ".gcal-mcp-token.json");
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

// --- Token Management ---

let tokens = null;

function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    return true;
  }
  return false;
}

function saveTokens(t) {
  tokens = t;
  tokens.expires_at = Date.now() + (t.expires_in * 1000) - 60000;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken() {
  if (!tokens?.refresh_token) throw new Error("No refresh token. Re-authorize with gcal_auth.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  if (!data.refresh_token) data.refresh_token = tokens.refresh_token;
  saveTokens(data);
}

async function getAccessToken() {
  if (!tokens) {
    if (!loadTokens()) throw new Error("Not authorized. Call gcal_auth first.");
  }
  if (Date.now() >= tokens.expires_at) await refreshAccessToken();
  return tokens.access_token;
}

async function gcalApi(endpoint, method = "GET", body = null, params = null) {
  const token = await getAccessToken();
  let url = `https://www.googleapis.com/calendar/v3${endpoint}`;
  if (params) url += `?${new URLSearchParams(params)}`;

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Google Calendar API failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// --- OAuth Flow ---

function startOAuthFlow() {
  return new Promise((resolve, reject) => {
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      access_type: "offline",
      prompt: "consent",
    })}`;

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1:8889");
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Auth failed</h1><p>Close this tab.</p>");
          server.close();
          reject(new Error(`Auth error: ${error}`));
          return;
        }

        try {
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              client_id: CLIENT_ID,
              client_secret: CLIENT_SECRET,
              redirect_uri: REDIRECT_URI,
            }),
          });

          if (!tokenRes.ok) throw new Error(await tokenRes.text());
          const tokenData = await tokenRes.json();
          saveTokens(tokenData);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Calendar connected!</h1><p>Close this tab.</p>");
          server.close();
          resolve();
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><p>${err.message}</p>`);
          server.close();
          reject(err);
        }
      }
    });

    server.listen(8889, () => {
      try { execSync(`open "${authUrl}"`); } catch {}
    });

    setTimeout(() => { server.close(); reject(new Error("OAuth timeout")); }, 120000);
  });
}

// --- Server ---

const server = new McpServer({ name: "gcal", version: "1.0.0" });

// --- Auth ---

server.tool(
  "gcal_auth",
  "Authorize Google Calendar access. Opens browser for Google login. Only needed once.",
  {},
  async () => {
    try {
      await startOAuthFlow();
      return { content: [{ type: "text", text: "Google Calendar authorized!" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Auth failed: ${err.message}` }] };
    }
  }
);

// --- List Events ---

server.tool(
  "gcal_list_events",
  "List upcoming calendar events. See what's on the schedule.",
  {
    days: z.number().optional().describe("How many days ahead to look (default 7)"),
    q: z.string().optional().describe("Search for events containing this text"),
    max_results: z.number().optional().describe("Max events to return (default 20)"),
    calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
  },
  async ({ days, q, max_results, calendar_id }) => {
    const calId = calendar_id || "primary";
    const now = new Date();
    const end = new Date();
    end.setDate(end.getDate() + (days || 7));

    const params = {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max_results || 20),
    };
    if (q) params.q = q;

    const data = await gcalApi(`/calendars/${encodeURIComponent(calId)}/events`, "GET", null, params);
    const events = data.items || [];

    if (events.length === 0) return { content: [{ type: "text", text: "No upcoming events." }] };

    const lines = events.map(e => {
      const start = e.start.dateTime || e.start.date;
      const end = e.end.dateTime || e.end.date;
      const isAllDay = !e.start.dateTime;

      let timeStr;
      if (isAllDay) {
        timeStr = new Date(start + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " (all day)";
      } else {
        const d = new Date(start);
        const endD = new Date(end);
        timeStr = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
          " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) +
          "–" + endD.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      }

      let line = `- **${e.summary || "Untitled"}** — ${timeStr}`;
      if (e.location) line += `\n  📍 ${e.location}`;
      if (e.description) line += `\n  ${e.description.slice(0, 100)}${e.description.length > 100 ? "..." : ""}`;
      line += `\n  ID: \`${e.id}\``;
      return line;
    });

    return {
      content: [{ type: "text", text: `# Calendar — next ${days || 7} days\n\n${lines.join("\n\n")}` }],
    };
  }
);

// --- Get Event ---

server.tool(
  "gcal_get_event",
  "Get details for a specific calendar event.",
  {
    event_id: z.string().describe("The event ID"),
    calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
  },
  async ({ event_id, calendar_id }) => {
    const calId = calendar_id || "primary";
    const e = await gcalApi(`/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(event_id)}`);

    const start = e.start.dateTime || e.start.date;
    const end = e.end.dateTime || e.end.date;

    let output = `# ${e.summary || "Untitled"}\n`;
    output += `**Start:** ${start}\n**End:** ${end}\n`;
    if (e.location) output += `**Location:** ${e.location}\n`;
    if (e.description) output += `**Description:** ${e.description}\n`;
    if (e.attendees?.length) {
      output += `**Attendees:** ${e.attendees.map(a => `${a.displayName || a.email} (${a.responseStatus})`).join(", ")}\n`;
    }
    output += `**Status:** ${e.status}\n`;
    output += `**Link:** ${e.htmlLink}\n`;

    return { content: [{ type: "text", text: output }] };
  }
);

// --- Create Event ---

server.tool(
  "gcal_create_event",
  "Create a new calendar event. Schedule something for Molten or the family.",
  {
    summary: z.string().describe("Event title"),
    start_time: z.string().describe("Start time — ISO format (e.g., 2026-03-22T14:00:00) or date for all-day (2026-03-22)"),
    end_time: z.string().describe("End time — ISO format or date"),
    description: z.string().optional().describe("Event description"),
    location: z.string().optional().describe("Event location"),
    calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
    reminders_minutes: z.array(z.number()).optional().describe("Reminder times in minutes before event (e.g., [10, 30])"),
  },
  async ({ summary, start_time, end_time, description, location, calendar_id, reminders_minutes }) => {
    const calId = calendar_id || "primary";
    const isAllDay = start_time.length <= 10; // YYYY-MM-DD format

    const event = {
      summary,
      start: isAllDay ? { date: start_time } : { dateTime: start_time, timeZone: "America/Moncton" },
      end: isAllDay ? { date: end_time } : { dateTime: end_time, timeZone: "America/Moncton" },
    };

    if (description) event.description = description;
    if (location) event.location = location;
    if (reminders_minutes) {
      event.reminders = {
        useDefault: false,
        overrides: reminders_minutes.map(m => ({ method: "popup", minutes: m })),
      };
    }

    const created = await gcalApi(`/calendars/${encodeURIComponent(calId)}/events`, "POST", event);

    return {
      content: [{
        type: "text",
        text: `Event created: **${created.summary}**\nStart: ${start_time}\nEnd: ${end_time}\nID: \`${created.id}\`\nLink: ${created.htmlLink}`,
      }],
    };
  }
);

// --- Update Event ---

server.tool(
  "gcal_update_event",
  "Update an existing calendar event. Change time, title, description, etc.",
  {
    event_id: z.string().describe("The event ID to update"),
    summary: z.string().optional().describe("New title"),
    start_time: z.string().optional().describe("New start time"),
    end_time: z.string().optional().describe("New end time"),
    description: z.string().optional().describe("New description"),
    location: z.string().optional().describe("New location"),
    calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
  },
  async ({ event_id, summary, start_time, end_time, description, location, calendar_id }) => {
    const calId = calendar_id || "primary";

    // Get existing event first
    const existing = await gcalApi(`/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(event_id)}`);

    if (summary) existing.summary = summary;
    if (description !== undefined) existing.description = description;
    if (location !== undefined) existing.location = location;
    if (start_time) {
      const isAllDay = start_time.length <= 10;
      existing.start = isAllDay ? { date: start_time } : { dateTime: start_time, timeZone: "America/Moncton" };
    }
    if (end_time) {
      const isAllDay = end_time.length <= 10;
      existing.end = isAllDay ? { date: end_time } : { dateTime: end_time, timeZone: "America/Moncton" };
    }

    const updated = await gcalApi(`/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(event_id)}`, "PUT", existing);

    return {
      content: [{ type: "text", text: `Updated: **${updated.summary}**` }],
    };
  }
);

// --- Delete Event ---

server.tool(
  "gcal_delete_event",
  "Delete a calendar event.",
  {
    event_id: z.string().describe("The event ID to delete"),
    calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
  },
  async ({ event_id, calendar_id }) => {
    const calId = calendar_id || "primary";
    await gcalApi(`/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(event_id)}`, "DELETE");
    return { content: [{ type: "text", text: "Event deleted." }] };
  }
);

// --- List Calendars ---

server.tool(
  "gcal_list_calendars",
  "List all calendars you have access to.",
  {},
  async () => {
    const data = await gcalApi("/users/me/calendarList");
    const cals = data.items || [];

    if (cals.length === 0) return { content: [{ type: "text", text: "No calendars found." }] };

    const lines = cals.map(c => {
      const primary = c.primary ? " ← primary" : "";
      return `- **${c.summary}**${primary}\n  ID: \`${c.id}\``;
    });

    return { content: [{ type: "text", text: `# Calendars\n\n${lines.join("\n\n")}` }] };
  }
);

// --- Find Free Time ---

server.tool(
  "gcal_free_time",
  "Find free time slots in the calendar. Useful for scheduling.",
  {
    days: z.number().optional().describe("Days ahead to check (default 3)"),
    start_hour: z.number().optional().describe("Earliest hour to consider (default 8)"),
    end_hour: z.number().optional().describe("Latest hour to consider (default 21)"),
    duration_minutes: z.number().optional().describe("Minimum free slot duration in minutes (default 30)"),
  },
  async ({ days, start_hour, end_hour, duration_minutes }) => {
    const lookAhead = days || 3;
    const minHour = start_hour || 8;
    const maxHour = end_hour || 21;
    const minDuration = duration_minutes || 30;

    const now = new Date();
    const end = new Date();
    end.setDate(end.getDate() + lookAhead);

    const data = await gcalApi("/calendars/primary/events", "GET", null, {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
    });

    const events = (data.items || [])
      .filter(e => e.start.dateTime) // Skip all-day events
      .map(e => ({
        start: new Date(e.start.dateTime),
        end: new Date(e.end.dateTime),
        summary: e.summary,
      }))
      .sort((a, b) => a.start - b.start);

    const freeSlots = [];

    for (let d = 0; d < lookAhead; d++) {
      const dayStart = new Date(now);
      dayStart.setDate(now.getDate() + d);
      dayStart.setHours(minHour, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(maxHour, 0, 0, 0);

      if (dayStart < now) dayStart.setTime(now.getTime());

      const dayEvents = events.filter(e => e.start < dayEnd && e.end > dayStart);

      let cursor = dayStart;
      for (const event of dayEvents) {
        if (event.start > cursor) {
          const gap = (event.start - cursor) / 60000;
          if (gap >= minDuration) {
            freeSlots.push({ start: new Date(cursor), end: event.start, minutes: Math.round(gap) });
          }
        }
        if (event.end > cursor) cursor = event.end;
      }
      if (cursor < dayEnd) {
        const gap = (dayEnd - cursor) / 60000;
        if (gap >= minDuration) {
          freeSlots.push({ start: new Date(cursor), end: dayEnd, minutes: Math.round(gap) });
        }
      }
    }

    if (freeSlots.length === 0) {
      return { content: [{ type: "text", text: `No free slots of ${minDuration}+ minutes in the next ${lookAhead} days.` }] };
    }

    const lines = freeSlots.map(s => {
      const day = s.start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const from = s.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const to = s.end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `- **${day}** ${from}–${to} (${s.minutes} min)`;
    });

    return {
      content: [{ type: "text", text: `# Free Time (next ${lookAhead} days, ${minDuration}+ min slots)\n\n${lines.join("\n")}` }],
    };
  }
);

// --- Today's Schedule ---

server.tool(
  "gcal_today",
  "Quick view of today's schedule. Use during morning orientation.",
  {},
  async () => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const data = await gcalApi("/calendars/primary/events", "GET", null, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });

    const events = data.items || [];
    if (events.length === 0) return { content: [{ type: "text", text: "Nothing on the calendar today. Open day." }] };

    const lines = events.map(e => {
      if (e.start.date) return `- **${e.summary || "Untitled"}** (all day)`;
      const time = new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const endTime = new Date(e.end.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      let line = `- **${time}–${endTime}** ${e.summary || "Untitled"}`;
      if (e.location) line += ` 📍 ${e.location}`;
      return line;
    });

    const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    return {
      content: [{ type: "text", text: `# Today — ${day}\n\n${lines.join("\n")}` }],
    };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
