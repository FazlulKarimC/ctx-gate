const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const root = resolve(process.argv[2]),
  id = process.argv[3];
async function main() {
  if (id.startsWith("picomatch-")) {
    const pm = require(root);
    assert.equal(pm.isMatch("file.js", "*.js"), true);
    assert.equal(pm.isMatch("file.txt", "*.js"), false);
    assert.equal(pm.isMatch(".hidden", "*"), false);
    assert.equal(pm.isMatch("a/b.js", "**/*.js"), true);
  } else if (id.startsWith("fastify-")) {
    const app = require(root)();
    try {
      app.get("/health", () => ({ ok: true }));
      app.post("/echo", (request) => request.body);
      const response = await app.inject("/health");
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ok: true });
      const posted = await app.inject({
        method: "POST",
        url: "/echo",
        payload: { value: 7 },
      });
      assert.equal(posted.statusCode, 200);
      assert.deepEqual(posted.json(), { value: 7 });
      assert.equal((await app.inject("/absent")).statusCode, 404);
    } finally {
      await app.close();
    }
  } else if (["json-server-h04", "json-server-h05"].includes(id)) {
    const { Service } = await import(
      pathToFileURL(join(root, "src/service.js")).href
    );
    const service = new Service({
      data: {
        posts: [
          { id: "1", title: "first" },
          { id: "2", title: "second" },
        ],
      },
    });
    assert.equal(service.find("posts", {}).length, 2);
    assert.equal(service.findById("posts", "1", {}).title, "first");
    assert.equal(service.findById("posts", "missing", {}), undefined);
  } else if (id.startsWith("json-server-")) {
    const jsonServer = require(join(root, "src/server/index.js")),
      app = jsonServer.create();
    app.use(jsonServer.defaults());
    app.use(
      jsonServer.router({
        posts: [
          { id: 1, title: "first" },
          { id: 2, title: "second" },
        ],
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(origin + "/posts");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).length, 2);
      assert.equal(
        (await (await fetch(origin + "/posts/1")).json()).title,
        "first",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } else throw Error("Unknown task");
  console.log(
    JSON.stringify({
      id,
      status: "passed",
      scope:
        "Deterministic pre-existing behavior smoke controls; not the full upstream suite",
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
