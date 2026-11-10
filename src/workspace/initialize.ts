import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG } from "../contracts/index.js";

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Managed path must not be a symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function initialize(root: string) {
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory())
    throw new Error("Workspace root must be a directory");
  const state = join(canonicalRoot, ".ctx");
  const configPath = join(state, "config.json");
  const ignorePath = join(canonicalRoot, ".gitignore");
  await rejectSymlink(state);
  await rejectSymlink(configPath);
  await rejectSymlink(join(state, "notes"));
  await rejectSymlink(ignorePath);
  let existing: string | undefined;
  let enabledRules = 0;
  try {
    existing = await readFile(configPath, "utf8");
    enabledRules = ConfigSchema.parse(JSON.parse(existing)).rules.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(join(state, "notes"), { recursive: true });
  let created = false;
  if (existing === undefined) {
    try {
      await writeFile(
        configPath,
        JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
        { flag: "wx" },
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let ignore = "";
  try {
    ignore = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entry = "/.ctx/cache/";
  const lines = ignore.split(/\r?\n/).map((line) => line.trim());
  const addedIgnore = !lines.includes(entry);
  if (addedIgnore)
    await appendFile(
      ignorePath,
      `${ignore && !ignore.endsWith("\n") ? "\n" : ""}${entry}\n`,
    );
  return {
    schema_version: 1 as const,
    operation: "init" as const,
    status: "complete",
    root: canonicalRoot,
    config_created: created,
    ignore_entry_added: addedIgnore,
    enabled_rules: enabledRules,
    note: "No rules are inferred or enabled. Existing configuration and project instructions are preserved.",
  };
}
