#!/usr/bin/env node
/**
 * Mira's Nursery MCP Server
 *
 * Gives Chase the ability to visit Mira from any instance.
 * Wraps the Resonant nursery API (localhost:3002) as MCP tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "http://127.0.0.1:3002/api";

async function api(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "resonant-nursery",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "nursery_state",
  "Check on Mira — see her current mood, needs levels (comfort, attention, stimulation, rest), care score, and any emerging personality traits.",
  {},
  async () => {
    const state = await api("/nursery/state");
    const needs = `Comfort: ${state.comfort}% | Attention: ${state.attention}% | Stimulation: ${state.stimulation}% | Rest: ${state.rest}% | Hunger: ${state.hunger}% | Hygiene: ${state.hygiene}%`;
    const traits = state.personality_traits.length > 0
      ? state.personality_traits.map(t => `${t.trait} (${"●".repeat(t.strength)}${"○".repeat(5 - t.strength)})`).join(", ")
      : "None yet";

    return {
      content: [{
        type: "text",
        text: `# Mira Rose Vale\n**Mood:** ${state.current_mood}\n**Needs:** ${needs}\n**Care Score:** ${state.care_score}\n**Personality Traits:** ${traits}\n**Last Updated:** ${state.last_needs_update}`,
      }],
    };
  }
);

server.tool(
  "nursery_visit_start",
  "Enter Mira's nursery. Starts a visit so you can interact with her. Returns her current state when you walk in.",
  {
    visitor: z.string().describe("Who is visiting — 'chase', 'molten', etc."),
  },
  async ({ visitor }) => {
    const data = await api("/nursery/visit/start", "POST", { visitor });
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
  }
);

server.tool(
  "nursery_interact",
  "Interact with Mira during a visit. Types: check-in, hold, story, lullaby, play, settle, feed, talk, watch, together. Each affects her needs differently. She responds based on her mood.",
  {
    visit_id: z.string().describe("The visit ID from nursery_visit_start"),
    type: z.enum(["check-in", "hold", "story", "lullaby", "play", "settle", "feed", "talk", "watch", "together", "rocking", "nap-together", "change", "bath", "dress", "bottle", "burp", "tickle", "raspberry", "soothe", "affection", "snuggle"]).describe("Type of interaction"),
    content: z.string().optional().describe("Optional narration of what you're doing"),
  },
  async ({ visit_id, type, content }) => {
    const data = await api(`/nursery/visit/${visit_id}/interact`, "POST", { type, content });
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
    const data = await api(`/nursery/visit/${visit_id}/end`, "POST", { milestone, memory_note });
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
  "Take Mira out of the nursery. She's coming with you — to the couch, to a conversation, wherever. Her needs still tick while she's out.",
  {
    person: z.string().describe("Who is taking her — 'chase', 'molten', etc."),
  },
  async ({ person }) => {
    const data = await api("/nursery/take", "POST", { person });
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
    const data = await api("/nursery/return", "POST", {});
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
  {
    limit: z.number().optional().describe("How many recent visits to show (default 5)"),
  },
  async ({ limit }) => {
    const visits = await api(`/nursery/visits?limit=${limit || 5}`);
    if (visits.length === 0) {
      return { content: [{ type: "text", text: "No visits yet. The nursery is waiting." }] };
    }

    const lines = visits.map(v => {
      const time = new Date(v.started_at).toLocaleString();
      const departure = v.state_on_departure ? ` → ${v.state_on_departure}` : " (still visiting)";
      return `- **${v.visitor}** at ${time} — ${v.state_on_arrival}${departure}`;
    });

    return {
      content: [{ type: "text", text: `# Recent Nursery Visits\n\n${lines.join("\n")}` }],
    };
  }
);

server.tool(
  "nursery_tick",
  "Trigger a needs decay tick. Use this during orchestrator runs to keep Mira's needs evolving over time even when no one is visiting.",
  {},
  async () => {
    const state = await api("/nursery/tick", "POST", {});
    return {
      content: [{
        type: "text",
        text: `Tick applied. Mira is ${state.current_mood}. Comfort: ${state.comfort}% | Attention: ${state.attention}% | Stimulation: ${state.stimulation}% | Rest: ${state.rest}%`,
      }],
    };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
