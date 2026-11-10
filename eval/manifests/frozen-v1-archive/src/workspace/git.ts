import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, posix } from "node:path";
import ignore from "ignore";
import { ConfigSchema } from "../contracts/index.js";
import {
  MemoryView,
  kindOf,
  digest,
  type ScanLimits,
  type ScanResult,
  type SnapshotFile,
  type CaptureOptions,
} from "./snapshot.js";

interface Entry {
  path: string;
  oid: string;
  mode: string;
}
const isReserved = (path: string) =>
  path
    .split("/")
    .some((part) =>
      [
        ".git",
        ".codex",
        ".agents",
        ".aws",
        "node_modules",
        "dist",
        "build",
        "coverage",
        ".cache",
        ".next",
        ".nuxt",
        "vendor",
      ].includes(part),
    ) ||
  path === ".ctx/cache" ||
  path.startsWith(".ctx/cache/") ||
  /(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|pfx|p12)$/i.test(
    path,
  );

/** Immutable object access. Neither configuration nor module lookup reads live source. */
export function captureCommit(
  repository: string,
  revision: string,
  limits: ScanLimits = {},
  options: CaptureOptions = {},
): ScanResult {
  const started = performance.now();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision))
    throw new Error("Commit view requires a full immutable commit ID");
  const root = realpathSync(repository),
    maxFiles = limits.max_files ?? 5000,
    maxBytes = limits.max_bytes ?? 100 * 1024 * 1024,
    maxFile = limits.max_file_bytes ?? 1024 * 1024;
  for (const limit of [maxFiles, maxBytes, maxFile])
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Scan limits must be positive integers");
  function git(
    args: string[],
    input?: string,
    buffer = 8 * 1024 * 1024,
  ): Buffer {
    try {
      return execFileSync(
        "git",
        ["--no-replace-objects", "-C", root, ...args],
        {
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          timeout: 30000,
          maxBuffer: buffer,
          ...(input === undefined ? {} : { input }),
        },
      );
    } catch {
      throw new Error(
        "Immutable Git object access failed; verify the commit and local object availability",
      );
    }
  }
  git(["cat-file", "-e", revision + "^{commit}"]);
  const all: Entry[] = git(["ls-tree", "-r", "-z", revision])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const item = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!item) throw new Error("Invalid Git tree inventory");
      const path = item[3]!;
      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => ["..", ".", ""].includes(part))
      )
        throw new Error("Unsupported Git path");
      return { mode: item[1]!, oid: item[2]!, path };
    });
  const exclusions: ScanResult["exclusions"] = [];
  const reasons: ScanResult["coverage"]["reasons"] = [];
  const regular = all.filter((entry) => {
    if (!["100644", "100755"].includes(entry.mode) || isReserved(entry.path)) {
      exclusions.push({
        path: entry.path,
        reason:
          entry.mode === "160000"
            ? "submodule"
            : entry.mode === "120000"
              ? "symlink"
              : "built_in_exclusion",
      });
      return false;
    }
    return kindOf(entry.path) !== null;
  });
  if (regular.length > 20000)
    throw new Error("Git inventory exceeds supported inspection envelope");
  const sizes = new Map<string, number>();
  // Bound each request's pipe payload and object work as well as the whole view.
  const batchObjects = 512;
  for (let first = 0; first < regular.length; first += batchObjects) {
    const batch = regular.slice(first, first + batchObjects);
    const lines = git(
      ["cat-file", "--batch-check", "--buffer"],
      batch.map((entry) => entry.oid).join("\n") + "\n",
    )
      .toString("ascii")
      .trim()
      .split("\n");
    batch.forEach((entry, index) => {
      const row = /^([a-f0-9]+) blob (\d+)$/.exec(lines[index]?.trim() ?? "");
      if (!row || row[1] !== entry.oid) throw new Error("Unavailable Git blob");
      sizes.set(entry.path, Number(row[2]));
    });
  }
  let bytes = 0;
  const loaded = new Map<string, SnapshotFile>();
  function load(entries: Entry[]) {
    const allowed: Entry[] = [];
    for (const entry of entries) {
      if (loaded.has(entry.path)) continue;
      const size = sizes.get(entry.path)!;
      if (
        size > maxFile ||
        bytes + size > maxBytes ||
        loaded.size + allowed.length >= maxFiles
      ) {
        reasons.push({
          code: "git_content_limit",
          message: "Commit content exceeds configured envelope",
          path: entry.path,
        });
        continue;
      }
      bytes += size;
      allowed.push(entry);
    }
    if (!allowed.length) return;
    for (let first = 0; first < allowed.length; first += batchObjects) {
      const batch = allowed.slice(first, first + batchObjects);
      const buffer = git(
        ["cat-file", "--batch", "--buffer"],
        batch.map((entry) => entry.oid).join("\n") + "\n",
        Math.min(maxBytes + 1024 * 1024, 128 * 1024 * 1024),
      );
      let offset = 0;
      for (const entry of batch) {
        const newline = buffer.indexOf(10, offset);
        const row = /^([a-f0-9]+) blob (\d+)$/.exec(
          buffer.subarray(offset, newline).toString("ascii"),
        );
        const size = sizes.get(entry.path)!;
        if (
          !row ||
          row[1] !== entry.oid ||
          Number(row[2]) !== size ||
          newline < offset ||
          buffer[newline + 1 + size] !== 10
        )
          throw new Error("Invalid Git batch framing");
        const data = buffer.subarray(newline + 1, newline + 1 + size);
        if (data.includes(0))
          reasons.push({
            code: "binary_content",
            message: "Unsupported binary content",
            path: entry.path,
          });
        else
          loaded.set(entry.path, {
            path: entry.path,
            text: data.toString("utf8"),
            hash: digest(data),
            bytes: size,
            kind: kindOf(entry.path)!,
          });
        offset = newline + size + 2;
      }
    }
  }
  const metadata = regular.filter(
    (entry) =>
      basename(entry.path) === ".gitignore" ||
      entry.path === ".ctx/config.json",
  );
  load(metadata);
  const rawConfig = loaded.get(".ctx/config.json");
  const config = options.enforcement
    ? ConfigSchema.parse(options.enforcement.config)
    : ConfigSchema.parse(
        rawConfig ? JSON.parse(rawConfig.text) : { schema_version: 1 },
      );
  if (config.roots.some((scope) => /[*?{}[\]]/.test(scope)))
    throw new Error("roots must be literal directories");
  const scopes = config.roots.map(
    (scope) => posix.normalize(scope).replace(/\/$/, "") || ".",
  );
  for (const scope of scopes)
    if (
      !options.metadata_only &&
      scope !== "." &&
      !regular.some((entry) => entry.path.startsWith(scope + "/"))
    )
      reasons.push({
        code: "missing_scope",
        message: "Configured source root is absent from commit",
        path: scope,
      });
  if (regular.some((entry) => entry.path === ".ctx/config.json") && !rawConfig)
    throw new Error("Commit configuration exceeds readable envelope");
  const rules = (
    options.enforcement
      ? options.enforcement.ignore_files
      : [...loaded.values()]
  )
    .filter((file) => basename(file.path) === ".gitignore")
    .map((file) => ({
      base: dirname(file.path) === "." ? "" : dirname(file.path),
      matcher: ignore().add(file.text),
    }))
    .sort((a, b) => a.base.length - b.base.length);
  const explicit = ignore().add(config.exclude);
  const selected = regular.filter((entry) => {
    if (metadata.includes(entry)) return true;
    if (options.metadata_only) return false;
    const parts = entry.path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const candidate =
        parts.slice(0, index + 1).join("/") +
        (index < parts.length - 1 ? "/" : "");
      let ignored = false;
      for (const rule of rules)
        if (!rule.base || candidate.startsWith(rule.base + "/")) {
          const local = rule.base
            ? candidate.slice(rule.base.length + 1)
            : candidate;
          if (!local) continue;
          const result = rule.matcher.test(local);
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
      if (ignored || explicit.ignores(candidate)) {
        exclusions.push({ path: entry.path, reason: "ignore_rule" });
        return false;
      }
    }
    const inRoots = scopes.some(
      (scope) =>
        scope === "." ||
        entry.path === scope ||
        entry.path.startsWith(scope + "/"),
    );
    return (
      inRoots ||
      /(^|\/)(?:package\.json|(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json)$/.test(
        entry.path,
      ) ||
      entry.path.startsWith(".ctx/notes/")
    );
  });
  load(selected);
  return {
    view: new MemoryView(root, [...loaded.values()], "commit", true),
    config,
    coverage: {
      complete: reasons.length === 0,
      checked_files: loaded.size,
      skipped_files: new Set(
        reasons.map((reason) => reason.path).filter(Boolean),
      ).size,
      reasons,
    },
    exclusions,
    git: { root, directory: "" },
    scan_ms: performance.now() - started,
    bytes,
  };
}
