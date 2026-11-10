import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  refreshIndex,
  captureWorktree,
  captureCommit,
  context,
} from "../dist/index.js";

async function fixture(t) {
  const parent = resolve(".cache/tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "operational-"));
  await cp(resolve("tests/fixtures/basic-project"), root, {
    recursive: true,
    filter: (path) => !path.includes(sep + "cache"),
  });
  t.after(async () => {
    const rel = relative(parent, root);
    assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("terminating an actual index publication rolls back partial writes and the next refresh recovers", async (t) => {
  const root = await fixture(t),
    before = refreshIndex(root);
  await writeFile(
    join(root, "src/db/session.ts"),
    "export const afterCancellation = true;\n",
  );
  const storeUrl = pathToFileURL(resolve("dist/store/index.js")).href,
    indexUrl = pathToFileURL(resolve("dist/index.js")).href;
  const script = `import {IndexStore} from ${JSON.stringify(storeUrl)};import {refreshIndex} from ${JSON.stringify(indexUrl)};const remove=IndexStore.prototype.removeFile;IndexStore.prototype.removeFile=function(path){remove.call(this,path);process.stdout.write('partial-publication\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);};refreshIndex(process.argv[1]);`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, root],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "",
    stderr = "";
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("No publication signal: " + stderr));
    }, 15000);
    child.stdout.on("data", (bytes) => {
      text += bytes;
      if (text.includes("partial-publication")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await closed;
  const db = new DatabaseSync(join(root, ".ctx/cache/index.sqlite"));
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(
      JSON.parse(db.prepare("SELECT payload FROM metadata").get().payload)
        .generation,
      before.generation,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM files WHERE path=?")
        .get("src/db/session.ts").n,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM symbols WHERE name=?")
        .get("afterCancellation").n,
      0,
    );
  } finally {
    db.close();
  }
  const after = refreshIndex(root);
  assert.equal(after.status, "complete");
  assert.equal(after.parsed_files, 1);
  assert.equal(after.generation, before.generation + 1);
});

test("persistent writer contention fails in bounded time without quarantining a healthy cache", async (t) => {
  const root = await fixture(t);
  refreshIndex(root);
  const db = new DatabaseSync(join(root, ".ctx/cache/index.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  let result;
  const started = performance.now();
  try {
    result = spawnSync(
      process.execPath,
      [resolve("dist/cli/index.js"), "index", "--root", root, "--json"],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /locked|busy/i);
  assert.ok(performance.now() - started < 10000);
  assert.ok(
    !(await readdir(join(root, ".ctx/cache"))).some((name) =>
      name.includes("recovered"),
    ),
  );
  assert.equal(refreshIndex(root).status, "complete");
});

test("scan byte guards and secret filename defaults preserve explicit coverage without returning sensitive text", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "src/.env.local"), "never-index-this-secret");
  await writeFile(join(root, "src/private.pem"), "never-index-this-key");
  await writeFile(
    join(root, "src/large.ts"),
    'export const large="' + "a".repeat(5000) + '";',
  );
  const scan = captureWorktree(root, { max_file_bytes: 1024 });
  assert.equal(scan.coverage.complete, false);
  assert.ok(
    scan.coverage.reasons.some((reason) => reason.path === "src/large.ts"),
  );
  assert.equal(scan.view.readFile("src/.env.local"), undefined);
  assert.equal(scan.view.readFile("src/private.pem"), undefined);
  assert.equal(scan.view.readFile("../outside.ts"), undefined);
  assert.equal(scan.view.readFile("C:/outside.ts"), undefined);
  assert.equal(
    await readFile(join(root, "src/.env.local"), "utf8"),
    "never-index-this-secret",
  );
});

test("a structurally valid corrupted cache cannot return invented source under a current content hash", async (t) => {
  const root = await fixture(t);
  refreshIndex(root);
  const db = new DatabaseSync(join(root, ".ctx/cache/index.sqlite"));
  db.prepare("UPDATE chunks SET text=? WHERE path=?").run(
    'export const inventedEvidence = "not actual source";',
    "src/ui/view.ts",
  );
  db.close();
  const result = await context(root, "path:src/ui/view.ts");
  for (const item of result.items) {
    const source = (await readFile(join(root, item.reference.path), "utf8"))
      .split("\n")
      .slice(item.reference.start_line - 1, item.reference.end_line)
      .join("\n");
    assert.equal(item.excerpt, source);
  }
  assert.ok(!JSON.stringify(result.items).includes("inventedEvidence"));
});

test("immutable bulk reads preserve every frame near the file-count limit", async (t) => {
  const root = await fixture(t);
  const git = (args, input) =>
    execFileSync("git", ["-C", root, ...args], {
      input,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  git(["init", "--quiet"]);
  git(["config", "user.name", "Bulk Test"]);
  git(["config", "user.email", "bulk@example.invalid"]);
  const text = "export const shared = 1;\n",
    blob = git(["hash-object", "-w", "--stdin"], text);
  const tree = git(
    ["mktree"],
    Array.from(
      { length: 4998 },
      (_, index) =>
        `100644 blob ${blob}\tfile${String(index).padStart(5, "0")}.ts`,
    ).join("\n") + "\n",
  );
  const commit = git([
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    tree,
    "-m",
    "bulk fixture",
  ]);
  const scan = captureCommit(root, commit);
  assert.equal(scan.coverage.complete, true);
  assert.equal(scan.view.files.size, 4998);
  assert.equal(scan.view.readFile("file04997.ts"), text);
  assert.equal(scan.bytes, 4998 * Buffer.byteLength(text));
});
