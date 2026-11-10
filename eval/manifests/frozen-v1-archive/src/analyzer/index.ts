import ts from "typescript";
import { builtinModules, isBuiltin } from "node:module";
import { resolve, dirname, relative, basename, isAbsolute } from "node:path";
import { type Coverage } from "../contracts/index.js";
import {
  MemoryView,
  forward,
  digest,
  type SnapshotFile,
} from "../workspace/snapshot.js";

export const ANALYZER_VERSION = "syntactic-v1/ts-" + ts.version;
export interface SymbolFact {
  name: string;
  kind: string;
  signature: string;
  start_line: number;
  end_line: number;
}
export interface RawImport {
  specifier: string | null;
  form: string;
  kind: "runtime" | "type_only";
  line: number;
  mode: "import" | "require";
  unsupported?: string;
}
export interface SyntaxFacts {
  symbols: SymbolFact[];
  imports: RawImport[];
  errors: string[];
}
export type ResolutionState =
  | "resolved_local"
  | "external_declared"
  | "builtin"
  | "unresolved_local"
  | "unsupported_local"
  | "unknown";
export interface ImportFact extends RawImport {
  source: string;
  target: string | null;
  resolution: ResolutionState;
  detail: string;
}
interface Project {
  path: string | null;
  options: ts.CompilerOptions;
  files: Set<string>;
  valid: boolean;
}
interface PackageInfo {
  path: string;
  data: Record<string, unknown>;
}
export interface AnalysisContext {
  view: MemoryView;
  host: ts.ModuleResolutionHost;
  projects: Project[];
  packages: PackageInfo[];
  reasons: Coverage["reasons"];
  fingerprint: string;
}
const defaultOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowJs: true,
  resolveJsonModule: true,
};
const canonical = (view: MemoryView, path: string) =>
  view.case_sensitive ? path : path.toLowerCase();
const diagnosticText = (diagnostic: ts.Diagnostic) =>
  ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

export function buildAnalysisContext(view: MemoryView): AnalysisContext {
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => view.fileExists(path),
    readFile: (path) => view.readFile(path),
    directoryExists: (path) => view.directoryExists(path),
    realpath: (path) => view.realpath(path),
    getCurrentDirectory: () => view.root,
    getDirectories: (path) => view.getDirectories(path),
    useCaseSensitiveFileNames: view.case_sensitive,
  };
  const reasons: Coverage["reasons"] = [];
  const packages: PackageInfo[] = [];
  for (const file of view.files.values())
    if (basename(file.path) === "package.json") {
      try {
        const data: unknown = JSON.parse(file.text);
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Expected object");
        packages.push({
          path: file.path,
          data: data as Record<string, unknown>,
        });
      } catch {
        reasons.push({
          code: "invalid_manifest",
          message: "Package manifest is not a JSON object",
          path: file.path,
        });
      }
    }
  const projects: Project[] = [];
  const visited = new Set<string>();
  function addProject(path: string) {
    const key = canonical(view, path);
    if (visited.has(key)) return;
    visited.add(key);
    const parsedFile = ts.readConfigFile(path, host.readFile);
    if (parsedFile.error) {
      reasons.push({
        code: "configuration_error",
        message: diagnosticText(parsedFile.error),
        path: forward(relative(view.root, path)),
      });
      return;
    }
    const parsed = ts.parseJsonConfigFileContent(
      parsedFile.config,
      {
        ...host,
        useCaseSensitiveFileNames: view.case_sensitive,
        readDirectory: (directory, extensions, excludes, includes, depth) =>
          view.readDirectory(directory, extensions, excludes, includes, depth),
      },
      dirname(path),
      undefined,
      path,
    );
    const errors = parsed.errors.filter((error) => error.code !== 18003);
    for (const error of errors)
      reasons.push({
        code: "configuration_error",
        message: diagnosticText(error),
        path: forward(relative(view.root, path)),
      });
    projects.push({
      path,
      options: parsed.options,
      files: new Set(
        parsed.fileNames.map((file) => canonical(view, resolve(file))),
      ),
      valid: errors.length === 0,
    });
    for (const reference of parsed.projectReferences ?? [])
      addProject(
        reference.path.endsWith(".json")
          ? reference.path
          : resolve(reference.path, "tsconfig.json"),
      );
  }
  for (const path of view.files.keys())
    if (["tsconfig.json", "jsconfig.json"].includes(basename(path)))
      addProject(resolve(view.root, path));
  const inputs = [...view.files.values()]
    .filter((file) => file.kind === "configuration" || file.kind === "metadata")
    .map((file) => [file.path, file.hash]);
  return {
    view,
    host,
    projects,
    packages,
    reasons,
    fingerprint: digest(JSON.stringify({ analyzer: ANALYZER_VERSION, inputs })),
  };
}

export function projectFor(context: AnalysisContext, path: string): Project {
  const absolute = resolve(context.view.root, path);
  const matches = context.projects
    .filter((project) => project.files.has(canonical(context.view, absolute)))
    .sort((a, b) => dirname(b.path!).length - dirname(a.path!).length);
  const first = matches[0];
  if (first) {
    if (
      matches[1] &&
      dirname(matches[1].path!).length === dirname(first.path!).length
    )
      return { ...first, valid: false };
    return first;
  }
  const nearby = context.projects
    .filter((project) => {
      const rel = forward(relative(dirname(project.path!), absolute));
      return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    })
    .sort((a, b) => dirname(b.path!).length - dirname(a.path!).length)[0];
  if (nearby) return { ...nearby, valid: false };
  return {
    path: null,
    options: defaultOptions,
    files: new Set([absolute]),
    valid: true,
  };
}

export function parseSource(
  file: SnapshotFile,
  context: AnalysisContext,
): SyntaxFacts {
  const project = projectFor(context, file.path);
  const source = ts.createSourceFile(
    resolve(context.view.root, file.path),
    file.text,
    ts.ScriptTarget.Latest,
    true,
  );
  source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(
    source.fileName,
    undefined,
    context.host,
    project.options,
  );
  // This one pinned-compiler runtime field is verified by the malformed-source tests.
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }
  ).parseDiagnostics;
  const errors = diagnostics
    ? diagnostics.map(diagnosticText)
    : ["Pinned compiler did not expose parse diagnostics"];
  if (!project.valid)
    errors.push("Ambiguous or invalid owning TypeScript configuration");
  const symbols: SymbolFact[] = [],
    imports: RawImport[] = [];
  let requireShadowed = false;
  function binding(node: ts.Node) {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name?.getText(source) === "require"
    )
      requireShadowed = true;
    ts.forEachChild(node, binding);
  }
  binding(source);
  const line = (position: number) =>
    source.getLineAndCharacterOfPosition(position).line + 1;
  function addImport(
    node: ts.Node,
    expression: ts.Expression | undefined,
    form: string,
    kind: RawImport["kind"],
  ) {
    const literal =
      expression && ts.isStringLiteralLike(expression) ? expression : undefined;
    const mode =
      form === "require" || form === "import_equals"
        ? "require"
        : form === "dynamic"
          ? "import"
          : literal &&
              ts.getModeForUsageLocation(source, literal, project.options) ===
                ts.ModuleKind.CommonJS
            ? "require"
            : "import";
    const item: RawImport = {
      specifier: literal?.text ?? null,
      form,
      kind,
      line: line(node.getStart(source)),
      mode,
    };
    if (!literal) item.unsupported = "Nonliteral module expression";
    else if (form === "require" && requireShadowed)
      item.unsupported =
        "A syntactic require binding makes CommonJS lookup ambiguous";
    imports.push(item);
  }
  function visit(node: ts.Node, prefix = "") {
    let name: string | undefined,
      kind: string | undefined,
      signature: string | undefined;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      name = node.name?.getText(source) ?? "<default>";
      kind = ts.SyntaxKind[node.kind];
      if (ts.isFunctionDeclaration(node))
        signature = node.body
          ? file.text
              .slice(node.getStart(source), node.body.getStart(source))
              .trim()
          : node.getText(source);
      else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))
        signature =
          (ts.isClassDeclaration(node) ? "class " : "interface ") +
          name +
          (node.heritageClauses
            ?.map((clause) => " " + clause.getText(source))
            .join("") ?? "");
      else signature = node.getText(source).slice(0, 1200);
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      name = ts.isConstructorDeclaration(node)
        ? "constructor"
        : node.name.getText(source);
      kind = "Method";
      signature =
        "body" in node && node.body
          ? file.text
              .slice(node.getStart(source), node.body.getStart(source))
              .trim()
          : node.getText(source).slice(0, 1200);
    } else if (ts.isVariableDeclaration(node)) {
      name = node.name.getText(source);
      kind = "Variable";
      signature = name + (node.type ? ": " + node.type.getText(source) : "");
      if (
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      )
        signature +=
          "(" +
          node.initializer.parameters
            .map((parameter) => parameter.getText(source))
            .join(", ") +
          ")" +
          (node.initializer.type
            ? ": " + node.initializer.type.getText(source)
            : "");
    }
    if (name && kind && signature && symbols.length < 5000)
      symbols.push({
        name: prefix + name,
        kind,
        signature: signature.slice(0, 1600),
        start_line: line(node.getStart(source)),
        end_line: line(node.getEnd()),
      });
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      addImport(
        node,
        node.moduleSpecifier,
        "import",
        typeOnly ? "type_only" : "runtime",
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      addImport(
        node,
        node.moduleSpecifier,
        "reexport",
        typeOnly ? "type_only" : "runtime",
      );
    } else if (ts.isImportTypeNode(node))
      addImport(
        node,
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        "import_type",
        "type_only",
      );
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      addImport(
        node,
        node.moduleReference.expression,
        "import_equals",
        node.isTypeOnly ? "type_only" : "runtime",
      );
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      addImport(node, node.arguments[0], "dynamic", "runtime");
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    )
      addImport(node, node.arguments[0], "require", "runtime");
    const childPrefix =
      name &&
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node))
        ? prefix + name + "."
        : prefix;
    ts.forEachChild(node, (child) => visit(child, childPrefix));
  }
  visit(source);
  if (symbols.length === 5000) errors.push("Per-file symbol limit reached");
  return { symbols, imports, errors };
}

function packageRoot(specifier: string) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
}
function nearestPackage(context: AnalysisContext, path: string) {
  return context.packages
    .filter(
      (pkg) =>
        path === dirname(pkg.path) ||
        dirname(pkg.path) === "." ||
        path.startsWith(forward(dirname(pkg.path)) + "/"),
    )
    .sort((a, b) => dirname(b.path).length - dirname(a.path).length)[0];
}
export function resolveImports(
  file: SnapshotFile,
  syntax: SyntaxFacts,
  context: AnalysisContext,
): ImportFact[] {
  const project = projectFor(context, file.path);
  const cache = ts.createModuleResolutionCache(
    context.view.root,
    (path) => canonical(context.view, path),
    project.options,
  );
  return syntax.imports.map((raw) => {
    const result = (
      resolution: ResolutionState,
      target: string | null,
      detail: string,
    ): ImportFact => ({
      ...raw,
      source: file.path,
      resolution,
      target,
      detail,
    });
    if (raw.unsupported || !raw.specifier)
      return result(
        "unsupported_local",
        null,
        raw.unsupported ?? "No literal specifier",
      );
    if (!project.valid || syntax.errors.length)
      return result(
        "unsupported_local",
        null,
        "Source/configuration has incomplete syntactic coverage",
      );
    const specifier = raw.specifier;
    if (specifier.startsWith("node:") && isBuiltin(specifier))
      return result("builtin", null, "Runtime builtin");
    const resolved = ts.resolveModuleName(
      specifier,
      resolve(context.view.root, file.path),
      project.options,
      context.host,
      cache,
      undefined,
      raw.mode === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
    ).resolvedModule;
    if (resolved && context.view.fileExists(resolved.resolvedFileName))
      return result(
        "resolved_local",
        forward(
          relative(
            context.view.root,
            context.view.realpath(resolved.resolvedFileName),
          ),
        ),
        "Compiler-resolved within captured source view",
      );
    if (isBuiltin(specifier) || builtinModules.includes(specifier))
      return result("builtin", null, "Runtime builtin");
    const pkg = nearestPackage(context, file.path),
      rootName = packageRoot(specifier);
    const alias = Object.keys(project.options.paths ?? {}).some((pattern) => {
      const star = pattern.indexOf("*");
      return star < 0
        ? specifier === pattern
        : specifier.startsWith(pattern.slice(0, star)) &&
            specifier.endsWith(pattern.slice(star + 1)) &&
            specifier.length >= pattern.length - 1;
    });
    const allDependencies = Object.assign(
      {},
      pkg?.data.dependencies,
      pkg?.data.devDependencies,
      pkg?.data.peerDependencies,
      pkg?.data.optionalDependencies,
    ) as Record<string, unknown>;
    const declared = allDependencies[rootName];
    const localPackage = context.packages.some(
      (candidate) => candidate.data.name === rootName,
    );
    const localDeclaration =
      typeof declared === "string" &&
      /^(?:workspace:|file:|link:)/.test(declared);
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("#") ||
      alias ||
      localPackage ||
      localDeclaration
    )
      return result(
        alias || localPackage || localDeclaration || specifier.startsWith("#")
          ? "unsupported_local"
          : "unresolved_local",
        null,
        "Local path/alias/package could not be resolved within the supported snapshot",
      );
    if (typeof declared === "string")
      return result(
        "external_declared",
        null,
        "Declared external package; installed contents and exports are not validated",
      );
    return result(
      "unknown",
      null,
      "Bare import is not declared external or resolved locally",
    );
  });
}

export const splitIdentifiers = (text: string) =>
  text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./\\-]+/g, " ");
export function chunksFor(file: SnapshotFile, syntax?: SyntaxFacts) {
  if (file.kind === "metadata") return [];
  const lines = file.text.split("\n");
  const chunks: {
    start_line: number;
    end_line: number;
    text: string;
    identifiers: string;
    subtokens: string;
    signature: string;
  }[] = [];
  for (let start = 0; start < lines.length; start += 80) {
    const end = Math.min(start + 80, lines.length);
    const symbols =
      syntax?.symbols.filter(
        (symbol) => symbol.start_line < end + 1 && symbol.end_line > start,
      ) ?? [];
    const identifiers = symbols.map((symbol) => symbol.name).join(" ");
    chunks.push({
      start_line: start + 1,
      end_line: end,
      text: lines.slice(start, end).join("\n"),
      identifiers,
      subtokens: splitIdentifiers(identifiers + " " + file.path),
      signature: symbols.map((symbol) => symbol.signature).join("\n"),
    });
  }
  return chunks;
}
