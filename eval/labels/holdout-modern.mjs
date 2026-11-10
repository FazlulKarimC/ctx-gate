import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const root = resolve(process.argv[2]),
  id = process.argv[3];
const data = {
  posts: [
    { id: "1", title: "foo" },
    { id: "2", title: "bar" },
  ],
  comments: [{ id: "1", postId: "1" }],
};
if (id === "json-server-h05") {
  const { Service } = await import(
    pathToFileURL(join(root, "src/service.js")).href
  );
  const service = new Service({ data });
  assert.equal(
    service.findById("posts", "1", { _embed: "comments" }).comments.length,
    1,
  );
  assert.equal(
    service.findById("posts", "1", { _embed: ["comments"] }).comments.length,
    1,
  );
  assert.equal(service.find("posts", { _embed: "comments" }).length, 2);
  assert.equal(service.find("posts", {}).length, 2);
} else if (id === "json-server-h04") {
  const require = createRequire(join(root, "package.json"));
  const { Low, Memory } = await import(
    pathToFileURL(require.resolve("lowdb")).href
  );
  const { createApp } = await import(
    pathToFileURL(join(root, "src/app.js")).href
  );
  const cwd = join(root, "assessment-working");
  mkdirSync(join(cwd, "public"), { recursive: true });
  writeFileSync(
    join(cwd, "public", "ctxgate-probe.txt"),
    "project-public-content",
  );
  process.chdir(cwd);
  const app = createApp(new Low(new Memory(), data)),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/ctxgate-probe.txt`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "project-public-content");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} else throw Error("Unknown modern assessment");
console.log(JSON.stringify({ id, status: "passed" }));
