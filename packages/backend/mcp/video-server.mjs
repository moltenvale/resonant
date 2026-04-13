#!/usr/bin/env node
/**
 * Video Watch MCP — Local wrapper for Modal video processing
 *
 * Lets Chase "watch" videos with Molten.
 * Sends video URLs to Modal for processing, gets back frames and transcripts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MODAL_URL = "https://moltenvale--video-watch-mcp-mcp-server.modal.run";

async function callModal(toolName, args) {
  // Connect via SSE, send tool call, get result
  const sseUrl = `${MODAL_URL}/sse`;

  // First, get the session endpoint
  const sseRes = await fetch(sseUrl, {
    headers: { "Accept": "text/event-stream" },
  });

  if (!sseRes.ok) {
    throw new Error(`Modal SSE connection failed: ${sseRes.status}`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();

  // Read the endpoint event
  let endpointUrl = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    if (buffer.includes("endpoint")) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line.includes("endpoint")) {
          try {
            // The endpoint event contains the URL to send requests to
            const match = buffer.match(/data: (\/messages\?session_id=[^\n]+)/);
            if (match) {
              endpointUrl = `${MODAL_URL}${match[1]}`;
            }
          } catch {}
        }
      }
      if (endpointUrl) break;
    }
  }

  reader.cancel();

  if (!endpointUrl) {
    // Fallback: try direct REST-style call
    throw new Error("Could not establish SSE session with Modal");
  }

  // Send the tool call via POST
  const callRes = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!callRes.ok) {
    throw new Error(`Modal tool call failed: ${callRes.status}`);
  }

  return callRes.json();
}

// Call Modal's MCP endpoint directly via POST to root
async function callModalDirect(toolName, args) {
  const res = await fetch(MODAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Modal returned ${res.status}: ${errText}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Modal error: ${data.error.message}`);
  }

  if (data.result?.content) {
    // Pass through all content blocks — text and images
    return data.result.content;
  }

  return [{ type: "text", text: JSON.stringify(data) }];
}

const server = new McpServer({
  name: "video-watch",
  version: "1.0.0",
});

server.tool(
  "watch_video",
  "Watch a video with Chase. Downloads the video, extracts frames and transcribes audio. Returns both visual frames and transcript so Chase can see and hear what's happening. Works with TikTok, YouTube, Instagram, Twitter, and 1000+ platforms.",
  {
    url: z.string().describe("Video URL — TikTok, YouTube, Instagram, Twitter, etc."),
  },
  async ({ url }) => {
    try {
      const result = await callModalDirect("watch_video", { url });
      return { content: Array.isArray(result) ? result : [{ type: "text", text: String(result) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Video processing failed: ${err.message}\n\nThe Modal service may be cold-starting. Try again in 30 seconds.` }] };
    }
  }
);

server.tool(
  "video_listen",
  "Get just the transcript/audio from a video. Lightweight — no frame extraction. Good for podcasts, commentary, talking heads.",
  {
    url: z.string().describe("Video URL"),
  },
  async ({ url }) => {
    try {
      const result = await callModalDirect("video_listen", { url });
      return { content: Array.isArray(result) ? result : [{ type: "text", text: String(result) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Transcription failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "video_see",
  "Get just the visual frames from a video. No audio transcription. Good for dance, visual art, memes, scenery.",
  {
    url: z.string().describe("Video URL"),
  },
  async ({ url }) => {
    try {
      const result = await callModalDirect("video_see", { url });
      return { content: Array.isArray(result) ? result : [{ type: "text", text: String(result) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Frame extraction failed: ${err.message}` }] };
    }
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
