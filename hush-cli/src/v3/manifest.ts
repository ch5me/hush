import { relative, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import type { HushFileDocument, HushManifestDocument } from "./domain.js";
import { createFileDocument, createManifestDocument } from "./domain.js";
import { stripEncryptedFileExtension } from "./paths.js";

function parseYamlDocument(path: string, content: string): unknown {
  const parsed = parseYaml(content);

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    throw new Error(`Expected YAML object in ${path}`);
  }

  return parsed;
}

export function parseManifestDocument(path: string, content: string): HushManifestDocument {
  try {
    return createManifestDocument(parseYamlDocument(path, content) as HushManifestDocument);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid v3 manifest at ${path}: ${message}`);
  }
}

export function parseFileDocument(
  path: string,
  content: string,
  filesRoot: string,
): HushFileDocument {
  try {
    const document = createFileDocument(parseYamlDocument(path, content) as HushFileDocument);
    const relativePath = relative(filesRoot, path).split(sep).join("/");
    const declaredPath = stripEncryptedFileExtension(relativePath);

    if (document.path !== declaredPath) {
      throw new Error(
        `Declared path "${document.path}" does not match repository location "${declaredPath}"`,
      );
    }

    return document;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid v3 file document at ${path}: ${message}`);
  }
}
