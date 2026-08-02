import { join } from "node:path";

import { fs } from "./lib/fs.js";

function normalizeRepositoryPath(pathname: string): string | undefined {
  const cleaned = pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const [owner, repo] = cleaned.split("/");

  if (!owner || !repo) {
    return undefined;
  }

  return `${owner}/${repo}`;
}

function projectIdentifierFromRepository(repository: unknown): string | undefined {
  const value =
    typeof repository === "string"
      ? repository
      : typeof repository === "object" &&
          repository !== null &&
          "url" in repository &&
          typeof repository.url === "string"
        ? repository.url
        : undefined;

  if (!value) {
    return undefined;
  }

  const withoutGitPrefix = value.replace(/^git\+/, "");

  try {
    const parsed = new URL(withoutGitPrefix);
    const normalized = normalizeRepositoryPath(parsed.pathname);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall through to scp-style Git URL parsing.
  }

  const scpMatch = withoutGitPrefix.match(/^[^@]+@[^:]+:(.+)$/);
  if (scpMatch) {
    return normalizeRepositoryPath(scpMatch[1]);
  }

  return undefined;
}

export function getProjectIdentifier(root: string): string | undefined {
  const pkgPath = join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return undefined;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8") as string);
    return projectIdentifierFromRepository(pkg.repository);
  } catch {
    return undefined;
  }
}
