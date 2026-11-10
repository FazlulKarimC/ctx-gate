import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";

/** Export regular Git blobs without checking out history or using per-file processes. */
export async function exportTree(repository, revision, destination) {
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("An immutable full object ID is required");
  const gitOptions = {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 128 * 1024 * 1024,
  };
  const manifest = execFileSync(
    "git",
    ["-C", repository, "ls-tree", "-r", "-z", revision],
    gitOptions,
  );
  const entries = manifest
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("Malformed Git tree entry");
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    });
  const files = entries.filter(
    (entry) =>
      entry.type === "blob" && ["100644", "100755"].includes(entry.mode),
  );
  if (files.length > 5000)
    throw new Error("Export exceeds file-count envelope");
  const blobs = execFileSync("git", ["-C", repository, "cat-file", "--batch"], {
    ...gitOptions,
    input: files.map((file) => file.oid).join("\n") + "\n",
  });
  let offset = 0;
  let total = 0;
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const newline = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, newline).toString("ascii");
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== file.oid)
      throw new Error(`Missing/mismatched Git blob: ${file.path}`);
    const size = Number(match[2]);
    total += size;
    if (total > 100 * 1024 * 1024)
      throw new Error("Export exceeds byte envelope");
    const start = newline + 1;
    if (start + size >= blobs.length || blobs[start + size] !== 10)
      throw new Error("Truncated Git batch output");
    const target = resolve(root, file.path);
    const rel = relative(root, target);
    if (
      !rel ||
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      file.path.split("/").includes(".git")
    )
      throw new Error("Unsafe Git export path");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobs.subarray(start, start + size), {
      flag: "wx",
    });
    offset = start + size + 1;
  }
  return {
    files: files.length,
    bytes: total,
    skipped: entries
      .filter((entry) => !files.includes(entry))
      .map((entry) => ({ path: entry.path, mode: entry.mode })),
  };
}
