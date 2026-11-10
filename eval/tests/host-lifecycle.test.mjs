import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observedHostProcess } from "../scripts/observed-host-process.mjs";

const fixture = `const mode=process.argv[1];
console.log(JSON.stringify({type:'turn.started'}));
if(mode==='quota')process.stderr.write('429 Too many requests: usage limit reached');
if(mode==='normal'||mode==='hang')console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2}}));
if(mode!=='normal')setInterval(()=>{},1000);`;
async function run(mode, options = {}) {
  const output = await mkdtemp(join(tmpdir(), "ctxgate-lifecycle-test-"));
  return {
    output,
    result: await observedHostProcess(process.execPath, ["-e", fixture, mode], {
      cwd: output,
      output,
      timeout_ms: 3000,
      cleanup_grace_ms: 100,
      ...options,
    }),
  };
}
test("normal terminal event and process exit are distinct recorded lifecycle events", async () => {
  const { result, output } = await run("normal");
  assert.equal(result.model_turn_completed, true);
  assert.equal(result.cleanup_forced, false);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stop_batch, false);
  const lifecycle = (await readFile(join(output, "lifecycle.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(lifecycle.some((event) => event.type === "model_turn_completed"));
  assert(lifecycle.some((event) => event.type === "process_exit"));
  assert(lifecycle.some((event) => event.type === "streams_closed"));
});
test("completed turn followed by a real hung child is bounded cleanup, not a task timeout", async () => {
  const { result, output } = await run("hang");
  assert.equal(result.model_turn_completed, true);
  assert.equal(result.cleanup_forced, true);
  assert.equal(result.cleanup_incomplete, false);
  assert.equal(result.timed_out, false);
  assert(result.elapsed_ms < 3000);
  assert.equal(result.events.at(-1).usage.input_tokens, 10);
  assert(
    (await readFile(join(output, "events.jsonl"), "utf8")).includes(
      '"turn.completed"',
    ),
  );
});
test("a real child without completion still consumes the task deadline", async () => {
  const { result } = await run("waiting", { timeout_ms: 300 });
  assert.equal(result.timed_out, true);
  assert.equal(result.model_turn_completed, false);
  assert.equal(result.turn_completed_ms, null);
});
test("stderr-only quota failure stops immediately and preserves raw stderr", async () => {
  const { result, output } = await run("quota");
  assert.equal(result.account_limit_detected, true);
  assert.equal(result.stop_batch, true);
  assert.equal(result.model_turn_completed, false);
  assert.match(
    await readFile(join(output, "stderr.txt"), "utf8"),
    /429 Too many requests/,
  );
});
test("unexpected process failure after a completed event remains an infrastructure stop", async () => {
  const output = await mkdtemp(join(tmpdir(), "ctxgate-lifecycle-test-"));
  const result = await observedHostProcess(
    process.execPath,
    [
      "-e",
      'console.log(JSON.stringify({type:"turn.completed"}));process.exitCode=7',
    ],
    { cwd: output, output, timeout_ms: 3000, cleanup_grace_ms: 100 },
  );
  assert.equal(result.exit_code, 7);
  assert.equal(result.unexpected_exit, true);
  assert.equal(result.stop_batch, true);
  assert.equal(result.model_turn_completed, false);
});
test("raw events persist before an external supervisor abort, without a final buffered summary", async () => {
  const output = await mkdtemp(join(tmpdir(), "ctxgate-lifecycle-test-")),
    controller = new AbortController();
  const running = observedHostProcess(
    process.execPath,
    ["-e", fixture, "hang"],
    {
      cwd: output,
      output,
      timeout_ms: 3000,
      cleanup_grace_ms: 2000,
      signal: controller.signal,
    },
  );
  let persisted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      persisted = (
        await readFile(join(output, "events.jsonl"), "utf8")
      ).includes('"turn.completed"');
    } catch {}
    if (persisted) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(persisted, true);
  assert(!(await readdir(output)).includes("process-result.json"));
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.stop_batch, true);
  assert.equal(result.model_turn_completed, false);
});
