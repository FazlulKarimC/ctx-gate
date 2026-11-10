// Assessment-only. Derived from the linked MIT-licensed upstream regression cases.
// This file must never be exported into an agent's task workspace.
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const [task, workspace] = process.argv.slice(2);
const picomatch = require(resolve(workspace, "index.js"));
const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
  }
};
const match = (input, pattern, options) => picomatch(pattern, options)(input);
switch (task) {
  case "picomatch-d01":
    check("adjacent literal does not cross separators", () =>
      assert.equal(match("somepath/test.thing.js", "**.thing.js"), false),
    );
    check("adjacent extension does not cross nested paths", () =>
      assert.equal(match("a/b/c.js", "**.js"), false),
    );
    check("same-segment file still matches", () =>
      assert.equal(match("test.thing.js", "**.thing.js"), true),
    );
    check("standalone globstar still crosses paths", () =>
      assert.equal(match("somepath/test.thing.js", "**/*.thing.js"), true),
    );
    break;
  case "picomatch-d02":
    for (const [input, pattern] of [
      ["hello\nworld", "**"],
      ["foo/hello\nworld", "**/*"],
      ["foo\nbar/bar", "**/bar"],
      ["foo\nbar/baz\nqux", "**/**"],
    ]) {
      check(`${JSON.stringify(input)} matches ${pattern}`, () =>
        assert.equal(match(input, pattern), true),
      );
    }
    check("hidden file rule retained", () =>
      assert.equal(match(".hidden", "**"), false),
    );
    break;
  case "picomatch-d03":
    for (const [input, parts] of [
      ["foo", ["foo"]],
      ["/", ["", ""]],
      ["/a/b/", ["", "a", "b", ""]],
      ["!(!(bar)/baz)", ["!(!(bar)/baz)"]],
      ["a/((b)/c)/d", ["a", "((b)/c)", "d"]],
    ]) {
      check(`complete parts for ${input}`, () =>
        assert.deepEqual(picomatch.scan(input, { parts: true }).parts, parts),
      );
    }
    break;
  case "picomatch-d04":
    check("tokens imply complete parts", () =>
      assert.deepEqual(picomatch.scan("a/b/*/c", { tokens: true }).parts, [
        "a",
        "b",
        "*",
        "c",
      ]),
    );
    check("existing explicit parts remain complete", () =>
      assert.deepEqual(picomatch.scan("a/b/*/c", { parts: true }).parts, [
        "a",
        "b",
        "*",
        "c",
      ]),
    );
    break;
  case "picomatch-d05":
    check("windows basename", () =>
      assert.equal(
        match("foo\\bar.js", "bar.js", { basename: true, windows: true }),
        true,
      ),
    );
    check("nested windows matchBase", () =>
      assert.equal(
        match("a\\b\\c\\d.md", "*.md", { matchBase: true, windows: true }),
        true,
      ),
    );
    check("mixed separators", () =>
      assert.equal(
        match("a/b\\c.js", "*.js", { matchBase: true, windows: true }),
        true,
      ),
    );
    check("negative match retained", () =>
      assert.equal(
        match("x\\y\\acb", "a?z", { matchBase: true, windows: true }),
        false,
      ),
    );
    break;
  default:
    throw new Error("Unregistered initial assessment task");
}
console.log(
  JSON.stringify({ task, checks, passed: checks.every((item) => item.passed) }),
);
process.exitCode = checks.every((item) => item.passed) ? 0 : 1;
