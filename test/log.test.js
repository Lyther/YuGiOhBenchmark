import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("pino writes its structured record to stderr and leaves stdout empty", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createLogger } from './src/log.js';
    createLogger('info').info({ probe: true }, 'transport check');
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const record = JSON.parse(result.stderr);
  assert.equal(record.msg, "transport check");
  assert.equal(record.probe, true);
  assert.equal(record.level, 30);
});
