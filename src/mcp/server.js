import { performance } from "node:perf_hooks";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

function resultSize(result) {
  return result.content.reduce((total, part) => total + (part.text?.length ?? 0), 0);
}

// Each call logs its name, duration and result size, so a result a runtime cut
// can be compared with what the seat sent.
function logged({ name, handler }, log) {
  return async (args) => {
    const started = performance.now();
    const result = await handler(args);
    log.info({ tool: name, ms: Math.round(performance.now() - started), chars: resultSize(result), isError: Boolean(result.isError) }, "tool call");
    return result;
  };
}

export function createServerFactory({ tools, log, version }) {
  return () => {
    const server = new McpServer({ name: "ygo", version }, { capabilities: { tools: {} } });
    for (const tool of tools) server.registerTool(tool.name, tool.config, logged(tool, log));
    return server;
  };
}

// stdio MCP for both protocol eras: the 2025-06-18 initialize that Codex and
// Gemini send is served, as is the stateless 2026 opening.
export function serveSeat({ tools, log, version }) {
  return serveStdio(createServerFactory({ tools, log, version }), {
    legacy: "serve",
    onerror: (error) => log.error({ err: error }, "mcp transport error"),
  });
}
