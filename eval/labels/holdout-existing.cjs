// Dependency-free execution of this fixed, inspected synchronous/Promise subset.
// This is not Mocha and is not a replacement for upstream npm test/lint/coverage.
const { resolve, join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const root = resolve(process.argv[2]);
const files = [
  "api.picomatch.js",
  "api.scan.js",
  "globstars.js",
  "stars.js",
  "dotfiles.js",
  "options.js",
  "slashes-posix.js",
  "slashes-windows.js",
  "non-globs.js",
].filter(
  (file) =>
    existsSync(join(root, "test", file)) &&
    !/\b(?:before|after|beforeEach|afterEach)\s*\(|\b(?:it|describe)\.(?:skip|only)\s*\(/.test(
      readFileSync(join(root, "test", file), "utf8"),
    ),
);
if (!files.length) throw Error("No compatible original test subset");
const tests = [],
  suites = [];
global.describe = (name, callback) => {
  suites.push(name);
  try {
    callback();
  } finally {
    suites.pop();
  }
};
global.it = (name, callback) => {
  if (callback.length)
    throw new Error("Callback-style test is outside this runner subset");
  tests.push({ name: [...suites, name].join(" / "), callback });
};
(async () => {
  for (const file of files) require(join(root, "test", file));
  const failures = [];
  for (const test of tests) {
    try {
      await test.callback();
    } catch (error) {
      failures.push({ name: test.name, error: error.message });
    }
  }
  console.log(
    JSON.stringify({
      runner: "version-qualified-describe-it-subset-v2",
      files,
      total: tests.length,
      passed: tests.length - failures.length,
      failures,
    }),
  );
  process.exitCode = failures.length ? 1 : 0;
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 2;
});
