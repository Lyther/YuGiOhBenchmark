import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readProgress, runFolder } from "../seat/record.js";

// The seat's own tools, under Droid's and Claude Code's MCP names, and the
// ToolSearch call that loads them.
const SEAT_TOOL = /^(?:ygo___|mcp__ygo__)|^ToolSearch$/;
const USAGE = "usage: steer.js <YGO_RUN_DIR> <YGO_ROOM> <YGO_NAME>, with the hook's JSON on stdin";

// A model can take another tool's success for a move: in two Droid matches an
// agent sent its answers through Execute as `echo choose5`, which succeeded and
// told it nothing (status.md). While its match runs, a non-seat tool's result
// gets this line. It blocks nothing.
export function steerText(toolName, progress) {
  if (!toolName || SEAT_TOOL.test(toolName) || !progress?.started || progress.ended) return null;
  return `${toolName} ran outside the game: it did not act in your match, which is still running. `
    + "Only the ygo tools act in it: call ygo___wait to see your open prompt, then answer it with ygo___answer.";
}

// A Droid PostToolUse hook (README "Run an agent match"). Errors exit 1, which
// Droid records without blocking the tool call.
function main() {
  const [runDir, room, name] = process.argv.slice(2);
  if (!runDir || !room || !name) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    process.stderr.write(`steer.js: the hook input is not JSON: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const text = steerText(input?.tool_name, readProgress(runFolder(runDir, room, name)));
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
}

// argv[1] keeps any symlink in the launch path; import.meta.url is the real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
