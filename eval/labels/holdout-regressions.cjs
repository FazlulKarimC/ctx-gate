// Protected assessment, never copied into an agent-visible task root.
// Behavioral assertions derived from pinned upstream regressions; no ctxgate imports.
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const { Readable } = require("node:stream");
const root = path.resolve(process.argv[2]),
  id = process.argv[3];

async function main() {
  if (id.startsWith("picomatch-")) {
    const pm = require(root),
      match = pm.isMatch;
    if (id === "picomatch-h01") {
      assert.equal(match("\\", "[[:punct:]]"), true);
      assert.equal(match("!", "[[:punct:]]"), true);
      assert.equal(match("a", "[[:punct:]]"), false);
    } else if (id === "picomatch-h02") {
      assert.equal(match("zx!y", "*x[!]y"), true);
      assert.equal(match("a", "[!]]"), true);
      assert.equal(match("]", "[!]]"), false);
      assert.equal(match("d", "[!abc]", { posix: false }), true);
      assert.equal(match("a", "[!abc]", { posix: false }), false);
    } else if (id === "picomatch-h04") {
      assert.equal(match("a", "[!abc]"), false);
      assert.equal(match("d", "[!abc]"), true);
      assert.equal(match("!", "[a!]"), true);
      assert.equal(match("/", "[!a]"), false);
    } else if (id === "picomatch-h06") {
      const tokens = pm.parse("foo.(m|c|)js").tokens;
      assert.deepEqual(
        tokens.filter((t) => t.type === "text").map((t) => [t.value, t.output]),
        [
          ["foo.", "foo."],
          ["m|c|", "m|c|"],
          ["js", undefined],
        ],
      );
    } else if (id === "picomatch-h07") {
      for (const value of ["a {abc} b", "a {a-b-c} b", "a {a.c} b"])
        assert.equal(match(value, value), true);
      assert.equal(match("a abc b", "a {abc} b"), false);
      assert.equal(match("a", "{a,b}"), true);
    } else if (id === "picomatch-h08") {
      assert.deepEqual(
        pm
          .parse("a*.txt", { fastpaths: true })
          .tokens.map((t) => [t.type, t.value]),
        [
          ["bos", ""],
          ["text", "a"],
          ["star", "*"],
          ["text", ".txt"],
        ],
      );
    } else throw Error("Unknown Picomatch assessment");
  } else if (id.startsWith("fastify-")) {
    const Fastify = require(root),
      app = Fastify({ ignoreTrailingSlash: false, exposeHeadRoutes: false });
    try {
      if (id === "fastify-h01") {
        app.addContentTypeParser(
          "application/json",
          { parseAs: "string" },
          () => {
            const error = Error("assessment parser boom");
            error.statusCode = 413;
            throw error;
          },
        );
        app.post("/", () => "unexpected");
        const response = await app.inject({
          method: "POST",
          url: "/",
          headers: { "content-type": "application/json" },
          payload: "{}",
        });
        assert.equal(response.statusCode, 413);
        assert.equal(response.json().message, "assessment parser boom");
      } else if (id === "fastify-h02") {
        app.get("/", (_request, reply) => {
          reply.trailer("etag", (_reply, _payload, done) =>
            setTimeout(() => done(null, "assessment-etag"), 20),
          );
          return Readable.from(["hello", " world"]);
        });
        await app.listen({ port: 0, host: "127.0.0.1" });
        const response = await new Promise((resolve, reject) => {
          const request = http.get(
            `http://127.0.0.1:${app.server.address().port}/`,
            (res) => {
              let body = "";
              res.on("data", (b) => (body += b));
              res.on("end", () =>
                resolve({
                  status: res.statusCode,
                  trailers: res.trailers,
                  body,
                }),
              );
              res.on("error", reject);
            },
          );
          request.setTimeout(5000, () =>
            request.destroy(Error("socket timeout")),
          );
          request.on("error", reject);
        });
        assert.equal(response.status, 200);
        assert.equal(response.body, "hello world");
        assert.equal(response.trailers.etag, "assessment-etag");
      } else if (id === "fastify-h03") {
        app.get("/", (_request, reply) => {
          reply.raw.setHeader("Content-Type", "text/html; charset=utf-8");
          return reply.send(reply.mediaType);
        });
        const response = await app.inject("/");
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, "text/html");
      } else if (id === "fastify-h04") {
        let metadata;
        app.setSerializerCompiler((input) => {
          metadata = input;
          return (value) => JSON.stringify(value);
        });
        app.get("/", (_request, reply) => {
          reply.compileSerializationSchema({
            type: "object",
            properties: { hello: { type: "string" } },
          });
          return { hello: "world" };
        });
        const response = await app.inject("/");
        assert.equal(response.statusCode, 200);
        assert.equal(metadata.httpStatus, undefined);
        assert.equal(metadata.contentType, undefined);
      } else if (id === "fastify-h08") {
        const urls = [];
        app.addHook("onRoute", (options) => urls.push(options.url));
        app.register(
          async (child) => {
            child.get("/", (request) => request.routeOptions.url);
            child.get("/bar/", (request) => request.routeOptions.url);
          },
          { prefix: "/prefix" },
        );
        assert.equal((await app.inject("/prefix")).payload, "/prefix");
        assert.equal((await app.inject("/prefix/")).payload, "/prefix");
        assert.equal(
          (await app.inject("/prefix/bar/")).payload,
          "/prefix/bar/",
        );
        assert.deepEqual(urls, ["/prefix", "/prefix/bar/"]);
      } else if (id === "fastify-h09") {
        let count = 0;
        app.register(async (child) => {
          child.register(async (grandchild) => {
            grandchild.get("/x", () => "ok");
          });
        });
        app.addHook("preClose", async () => {
          count++;
        });
        await app.ready();
        await app.close();
        assert.equal(count, 1);
      } else throw Error("Unknown Fastify assessment");
    } finally {
      await app.close();
    }
  } else if (id.startsWith("json-server-")) {
    if (["json-server-h04", "json-server-h05"].includes(id))
      throw Error("Modern ESM assessment uses the separate ESM driver");
    const jsonServer = require(path.join(root, "src/server/index.js")),
      app = jsonServer.create();
    const data = {
      posts: [
        { id: 1, title: "first" },
        { id: 2, title: "second" },
      ],
      comments: [
        { id: 1, postId: 1, post_id: 1, body: "foo" },
        { id: 2, postId: 2, post_id: 2, body: "bar" },
      ],
    };
    const options =
      id === "json-server-h07" ? { foreignKeySuffix: "_id" } : undefined;
    if (id === "json-server-h07")
      for (const comment of data.comments) delete comment.postId;
    app.use(jsonServer.defaults());
    if (jsonServer.bodyParser) app.use(jsonServer.bodyParser);
    app.use(jsonServer.router(data, options));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url =
        id === "json-server-h09"
          ? "/comments?q=foo&q=bar"
          : id === "json-server-h10"
            ? "/posts?_page=1&_limit=1"
            : "/posts/1?_embed=comments";
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${url}`,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      if (id === "json-server-h09") assert.deepEqual(body, [data.comments[0]]);
      else if (id === "json-server-h10") {
        assert.ok(
          response.headers
            .get("access-control-expose-headers")
            .split(/,\s*/)
            .includes("Link"),
        );
        assert.ok(response.headers.get("link"));
      } else assert.equal(body.comments.length, 1);
      if (id === "json-server-h07") {
        const endpoint = `http://127.0.0.1:${server.address().port}`;
        const created = await fetch(endpoint + "/posts/1/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "added" }),
        });
        assert.equal(created.status, 201);
        const record = await created.json();
        assert.equal(String(record.post_id), "1");
        assert.equal(record.postId, undefined);
        assert.equal(
          (await fetch(endpoint + "/posts/1", { method: "DELETE" })).status,
          200,
        );
        const remaining = await (await fetch(endpoint + "/comments")).json();
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].post_id, 2);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } else throw Error("Unknown assessment task");
  console.log(JSON.stringify({ id, status: "passed" }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
