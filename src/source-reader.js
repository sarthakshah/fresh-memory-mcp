import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { FreshMemoryError } from "./errors.js";

export const SOURCE_KINDS = ["json_file", "text_file"];
export const SOURCE_MODES = ["auto", "review"];

const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export function normalizeSourcePath(path, roots = []) {
  if (typeof path !== "string" || !path.trim()) {
    throw new FreshMemoryError("path is required.");
  }

  if (roots.length === 0) {
    throw new FreshMemoryError(
      "Source tracking is disabled until FRESH_MEMORY_SOURCE_ROOTS is configured.",
      "SOURCE_ROOTS_REQUIRED",
    );
  }

  const candidate = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  let realPath;
  try {
    realPath = realpathSync(candidate);
  } catch (error) {
    throw new FreshMemoryError(`Source file could not be opened: ${candidate}.`, "SOURCE_UNAVAILABLE", {
      cause: error,
    });
  }

  if (!roots.some((root) => isWithinRoot(realPath, root))) {
    throw new FreshMemoryError(
      `Source file is outside FRESH_MEMORY_SOURCE_ROOTS: ${realPath}.`,
      "SOURCE_NOT_ALLOWED",
    );
  }

  return realPath;
}

export function inspectSource(source, { roots = [], maxBytes = DEFAULT_MAX_SOURCE_BYTES } = {}) {
  const path = normalizeSourcePath(source.path, roots);
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new FreshMemoryError(`Source is not a regular file: ${path}.`, "SOURCE_UNAVAILABLE");
  }
  if (stats.size > maxBytes) {
    throw new FreshMemoryError(
      `Source file exceeds the ${maxBytes} byte limit: ${path}.`,
      "SOURCE_TOO_LARGE",
    );
  }

  const content = readFileSync(path);
  if (source.kind === "text_file") {
    return {
      path,
      fingerprint: digest(content),
      value: { bytes: content.byteLength },
      proposed_statement: null,
    };
  }

  if (source.kind !== "json_file") {
    throw new FreshMemoryError(
      `kind must be one of: ${SOURCE_KINDS.join(", ")}.`,
    );
  }

  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch {
    throw new FreshMemoryError(`Source is not valid JSON: ${path}.`, "SOURCE_INVALID");
  }

  const value = readJsonPointer(document, source.selector);
  return {
    path,
    fingerprint: digest(Buffer.from(JSON.stringify(value))),
    value,
    proposed_statement: renderStatement(source.statement_template, value),
  };
}

export function parseSourceRoots(value = process.env.FRESH_MEMORY_SOURCE_ROOTS) {
  if (!value) {
    return [];
  }
  return normalizeSourceRoots(value
    .split(process.platform === "win32" ? ";" : ":")
    .map((root) => root.trim())
    .filter(Boolean));
}

export function normalizeSourceRoots(roots = []) {
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
    throw new FreshMemoryError("sourceRoots must be an array of directory paths.");
  }
  return roots.map((root) => {
    const absoluteRoot = resolve(root);
    try {
      return realpathSync(absoluteRoot);
    } catch {
      return absoluteRoot;
    }
  });
}

function readJsonPointer(document, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new FreshMemoryError("selector must be a JSON Pointer beginning with '/'.");
  }

  let value = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) {
      throw new FreshMemoryError(
        `selector ${pointer} was not found in the JSON source.`,
        "SOURCE_SELECTOR_NOT_FOUND",
      );
    }
    value = value[token];
  }
  return value;
}

function renderStatement(template, value) {
  if (typeof template !== "string" || !template.includes("{{value}}")) {
    throw new FreshMemoryError("statement_template must include {{value}}.");
  }
  const renderedValue = typeof value === "string" ? value : JSON.stringify(value);
  return template.replaceAll("{{value}}", renderedValue);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithinRoot(path, root) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}
