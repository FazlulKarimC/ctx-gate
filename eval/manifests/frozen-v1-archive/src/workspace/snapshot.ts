import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import {
  resolve,
  relative,
  dirname,
  basename,
  isAbsolute,
  sep,
} from "node:path";
import ignore, { type Ignore } from "ignore";
import { minimatch } from "minimatch";
import {
  ConfigSchema,
  type Config,
  type Coverage,
  type SourceView,
} from "../contracts/index.js";

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const forward = (value: string) => value.split(sep).join("/");
export const isNotePath = (path: string) =>
  path.toLowerCase().startsWith(".ctx/notes/");
export type FileKind =
  "source" | "documentation" | "configuration" | "metadata";
export interface SnapshotFile {
  path: string;
  text: string;
  hash: string;
  bytes: number;
  kind: FileKind;
}
export interface ScanLimits {
  max_files?: number;
  max_bytes?: number;
  max_file_bytes?: number;
}
/** Explicit trusted enforcement discovery; never derived from the candidate. */
export interface CaptureOptions {
  enforcement?: {
    config: Config;
    ignore_files: { path: string; text: string }[];
  };
  metadata_only?: boolean;
}
export interface ScanResult {
  view: MemoryView;
  config: Config;
  coverage: Coverage;
  exclusions: { path: string; reason: string }[];
  git: { root: string; directory: string } | null;
  scan_ms: number;
  bytes: number;
}
const directoriesToSkip = new Set([
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
]);
export function kindOf(path: string): FileKind | null {
  if (/^(?:package-lock|npm-shrinkwrap)\.json$/.test(basename(path)))
    return "metadata";
  if (/\.(?:[cm]?[jt]sx?)$/i.test(path)) return "source";
  if (/\.md$/i.test(path)) return "documentation";
  if (/\.(?:json|jsonc)$/i.test(path)) return "configuration";
  if (
    basename(path) === ".gitignore" ||
    /(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json)$/.test(
      path,
    )
  )
    return "metadata";
  return null;
}
const sensitive = (path: string) =>
  /(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|pfx|p12)$/i.test(
    path,
  );
const configurationInput = (path: string) =>
  /(^|\/)(?:package\.json|(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json|\.gitignore|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json)$/.test(
    path,
  ) || path === ".ctx/config.json";

/** The resolver has no filesystem fallback: every observation comes from this map. */
export class MemoryView implements SourceView {
  readonly id: string;
  readonly files: ReadonlyMap<string, SnapshotFile>;
  readonly kind: "worktree" | "commit";
  readonly root: string;
  readonly case_sensitive: boolean;
  private readonly lookup = new Map<string, SnapshotFile>();
  private readonly directories = new Set<string>([""]);
  constructor(
    root: string,
    files: readonly SnapshotFile[],
    kind: "worktree" | "commit" = "worktree",
    caseSensitive = process.platform !== "win32" &&
      process.platform !== "darwin",
  ) {
    this.root = resolve(root);
    this.kind = kind;
    this.case_sensitive = caseSensitive;
    const ordered = [...files].sort((a, b) =>
      a.path.localeCompare(b.path, "en"),
    );
    this.files = new Map(
      ordered.map((file) => [file.path, Object.freeze({ ...file })]),
    );
    for (const file of this.files.values()) {
      const key = this.canonical(file.path);
      if (this.lookup.has(key))
        throw new Error("Case-colliding source paths: " + file.path);
      this.lookup.set(key, file);
      let directory = forward(dirname(file.path));
      while (directory !== "." && directory !== "") {
        this.directories.add(this.canonical(directory));
        directory = forward(dirname(directory));
      }
    }
    this.id = digest(
      JSON.stringify({
        root: this.root,
        kind,
        caseSensitive,
        files: ordered.map((file) => [file.path, file.hash]),
      }),
    );
  }
  private canonical(path: string) {
    return this.case_sensitive ? path : path.toLowerCase();
  }
  private local(path: string): string | undefined {
    const rel = forward(relative(this.root, resolve(this.root, path)));
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      return undefined;
    return rel;
  }
  fileExists(path: string) {
    const rel = this.local(path);
    return rel !== undefined && this.lookup.has(this.canonical(rel));
  }
  directoryExists(path: string) {
    const rel = this.local(path);
    return rel !== undefined && this.directories.has(this.canonical(rel));
  }
  readFile(path: string) {
    const rel = this.local(path);
    return rel === undefined
      ? undefined
      : this.lookup.get(this.canonical(rel))?.text;
  }
  getCurrentDirectory() {
    return this.root;
  }
  realpath(path: string) {
    const rel = this.local(path);
    if (rel === undefined) throw new Error("Path is outside source view");
    return resolve(
      this.root,
      this.lookup.get(this.canonical(rel))?.path ?? rel,
    );
  }
  getDirectories(path: string) {
    const rel = this.local(path);
    if (rel === undefined) return [];
    const prefix = rel ? this.canonical(rel) + "/" : "";
    return [...this.directories]
      .filter(
        (entry) =>
          entry.startsWith(prefix) &&
          entry !== this.canonical(rel) &&
          !entry.slice(prefix.length).includes("/"),
      )
      .map((entry) => resolve(this.root, entry));
  }
  readDirectory(
    path: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
    includes?: readonly string[],
    depth?: number,
  ) {
    const rel = this.local(path);
    if (rel === undefined) return [];
    const prefix = rel ? rel + "/" : "";
    const match = (candidate: string, pattern: string) => {
      const p = forward(
        isAbsolute(pattern) ? relative(path, pattern) : pattern,
      ).replace(/^\.\//, "");
      return (
        minimatch(candidate, p, { dot: true, nocase: !this.case_sensitive }) ||
        (!/[?*{}[\]]/.test(p) &&
          candidate.startsWith(p.replace(/\/$/, "") + "/"))
      );
    };
    return [...this.files.keys()]
      .filter((file) => {
        if (!this.canonical(file).startsWith(this.canonical(prefix)))
          return false;
        const candidate = file.slice(prefix.length);
        return (
          (!extensions ||
            extensions.some((extension) => file.endsWith(extension))) &&
          (depth === undefined || candidate.split("/").length - 1 <= depth) &&
          (!includes ||
            includes.some((pattern) => match(candidate, pattern))) &&
          (!excludes || !excludes.some((pattern) => match(candidate, pattern)))
        );
      })
      .map((file) => resolve(this.root, file));
  }
}

export function captureWorktree(
  inputRoot: string,
  limits: ScanLimits = {},
  options: CaptureOptions = {},
): ScanResult {
  const started = performance.now();
  const root = realpathSync(inputRoot);
  if (!lstatSync(root).isDirectory())
    throw new Error("Workspace root must be a directory");
  const maxFiles = limits.max_files ?? 5000,
    maxBytes = limits.max_bytes ?? 100 * 1024 * 1024,
    maxFileBytes = limits.max_file_bytes ?? 1024 * 1024;
  for (const limit of [maxFiles, maxBytes, maxFileBytes])
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Scan limits must be positive integers");
  for (const managed of [".ctx", ".ctx/config.json"]) {
    const path = resolve(root, managed);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Managed configuration cannot be a symlink");
  }
  const configPath = resolve(root, ".ctx/config.json");
  if (
    !options.enforcement &&
    existsSync(configPath) &&
    lstatSync(configPath).size > maxFileBytes
  )
    throw new Error("Managed configuration exceeds file-size limit");
  const config = options.enforcement
    ? ConfigSchema.parse(options.enforcement.config)
    : existsSync(configPath)
      ? ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
      : ConfigSchema.parse({ schema_version: 1 });
  if (config.roots.some((path) => /[*?{}[\]]/.test(path)))
    throw new Error(
      "roots must be literal directories; use exclude for patterns",
    );
  const explicitExcludes = ignore().add(config.exclude);
  const exclusions: ScanResult["exclusions"] = [];
  const reasons: Coverage["reasons"] = [];
  const scopes = config.roots.map(
    (scope) => forward(relative(root, resolve(root, scope))) || ".",
  );
  for (const scope of scopes)
    if (
      !existsSync(resolve(root, scope)) ||
      !lstatSync(resolve(root, scope)).isDirectory()
    )
      reasons.push({
        code: "missing_scope",
        message: "Configured source root is absent or unsupported",
        path: scope,
      });
  const candidates: string[] = [];
  const ignoreFiles = new Map<string, string>();
  let visited = 0;
  function walk(
    directory: string,
    relativeDirectory: string,
    inherited: { base: string; matcher: Ignore }[],
  ) {
    if (++visited > 20000) {
      reasons.push({
        code: "directory_limit",
        message: "Directory scan limit reached",
      });
      return;
    }
    if (relativeDirectory && existsSync(resolve(directory, ".git"))) {
      exclusions.push({
        path: relativeDirectory,
        reason: "nested_repository_or_submodule",
      });
      return;
    }
    const gitignore = resolve(directory, ".gitignore");
    const rules = [...inherited];
    if (options.enforcement) {
      const key = relativeDirectory
        ? relativeDirectory + "/.gitignore"
        : ".gitignore";
      const trusted = options.enforcement.ignore_files.find(
        (file) => file.path === key,
      );
      if (trusted)
        rules.push({
          base: relativeDirectory,
          matcher: ignore().add(trusted.text),
        });
    } else if (
      existsSync(gitignore) &&
      !lstatSync(gitignore).isSymbolicLink()
    ) {
      if (lstatSync(gitignore).size > maxFileBytes) {
        reasons.push({
          code: "ignore_size_limit",
          message: "Ignore file exceeds size limit",
          path: relativeDirectory
            ? relativeDirectory + "/.gitignore"
            : ".gitignore",
        });
        return;
      }
      const text = readFileSync(gitignore, "utf8");
      ignoreFiles.set(
        relativeDirectory ? relativeDirectory + "/.gitignore" : ".gitignore",
        text,
      );
      rules.push({ base: relativeDirectory, matcher: ignore().add(text) });
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      const path = relativeDirectory
        ? relativeDirectory + "/" + entry.name
        : entry.name;
      if (entry.isSymbolicLink()) {
        exclusions.push({ path, reason: "symlink" });
        continue;
      }
      if (
        directoriesToSkip.has(entry.name) ||
        path === ".ctx/cache" ||
        sensitive(path)
      ) {
        exclusions.push({ path, reason: "built_in_exclusion" });
        continue;
      }
      const probe = entry.isDirectory() ? path + "/" : path;
      let ignored = false;
      for (const rule of rules) {
        const local = rule.base ? probe.slice(rule.base.length + 1) : probe;
        const result = rule.matcher.test(local);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored || explicitExcludes.ignores(probe)) {
        exclusions.push({ path, reason: "ignore_rule" });
        continue;
      }
      if (entry.isDirectory()) {
        try {
          walk(resolve(directory, entry.name), path, rules);
        } catch (error) {
          reasons.push({
            code: "directory_read_failed",
            message: (error as Error).message,
            path,
          });
        }
      } else if (entry.isFile() && kindOf(path)) {
        const inRoots = scopes.some(
          (scope) =>
            scope === "." ||
            path === scope ||
            path.startsWith(scope.replace(/\/$/, "") + "/"),
        );
        if (
          inRoots ||
          configurationInput(path) ||
          path.startsWith(".ctx/notes/")
        )
          candidates.push(path);
      }
    }
  }
  walk(root, "", []);
  let git: ScanResult["git"] = null;
  try {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        timeout: 5000,
      });
    git = {
      root: run("rev-parse", "--show-toplevel").trim(),
      directory: run("rev-parse", "--absolute-git-dir").trim(),
    };
    if (candidates.length && !options.enforcement) {
      try {
        const output = execFileSync(
          "git",
          ["-C", root, "check-ignore", "--no-index", "--stdin", "-z"],
          {
            input: candidates.join("\0") + "\0",
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        const ignored = new Set(output.split("\0").filter(Boolean));
        for (let i = candidates.length - 1; i >= 0; i--)
          if (ignored.has(candidates[i]!)) {
            exclusions.push({ path: candidates[i]!, reason: "git_ignore" });
            candidates.splice(i, 1);
          }
      } catch (error) {
        if ((error as { status?: number }).status !== 1)
          reasons.push({
            code: "git_ignore_failed",
            message: "Git global/info ignore evaluation failed",
          });
      }
    }
  } catch {
    /* Non-Git folders remain supported and are explicitly identified. */
  }
  const files: SnapshotFile[] = [];
  let bytes = 0;
  for (const path of [
    ...new Set([...candidates, ...ignoreFiles.keys()]),
  ].sort()) {
    if (files.length >= maxFiles) {
      reasons.push({
        code: "file_limit",
        message: "Eligible file count exceeds limit",
        path,
      });
      continue;
    }
    try {
      const absolute = resolve(root, path);
      const before = lstatSync(absolute);
      if (!before.isFile() || before.isSymbolicLink()) {
        reasons.push({
          code: "source_changed",
          message: "File kind changed during scan",
          path,
        });
        continue;
      }
      if (before.size > maxFileBytes || bytes + before.size > maxBytes) {
        reasons.push({
          code: "byte_limit",
          message: "Eligible content exceeds byte limit",
          path,
        });
        continue;
      }
      const actual = realpathSync(absolute);
      const rel = relative(root, actual);
      if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))
        throw new Error("Source escaped workspace root");
      const data = readFileSync(absolute);
      const after = lstatSync(absolute);
      if (
        data.length !== before.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino ||
        data.includes(0)
      ) {
        reasons.push({
          code: "unreadable_or_changed",
          message: "Source changed or is not supported text",
          path,
        });
        continue;
      }
      bytes += data.length;
      files.push({
        path,
        text: data.toString("utf8"),
        bytes: data.length,
        hash: digest(data),
        kind: kindOf(path)!,
      });
    } catch (error) {
      reasons.push({
        code: "read_failed",
        message: (error as Error).message,
        path,
      });
    }
  }
  return {
    view: new MemoryView(
      root,
      files,
      "worktree",
      options.enforcement ? true : undefined,
    ),
    config,
    coverage: {
      complete: reasons.length === 0,
      checked_files: files.length,
      skipped_files:
        new Set([...candidates, ...ignoreFiles.keys()]).size - files.length,
      reasons,
    },
    exclusions,
    git,
    scan_ms: performance.now() - started,
    bytes,
  };
}
