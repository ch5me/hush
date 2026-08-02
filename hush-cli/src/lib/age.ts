import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { fs } from "./fs.js";

export interface AgeKey {
  private: string;
  public: string;
}

export interface AgeKeyReference {
  project: string;
  public: string;
  path: string;
}

function getKeysDir(): string {
  return join(homedir(), ".config", "sops", "age", "keys");
}

export function ageAvailable(): boolean {
  const result = spawnSync("age-keygen", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

export function ageGenerate(): AgeKey {
  const result = spawnSync("age-keygen", [], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error("Failed to generate age key");
  const output = result.stdout;
  const pub = output.match(/public key: (age1[a-z0-9]+)/)?.[1];
  const priv = output.match(/(AGE-SECRET-KEY-[A-Z0-9]+)/)?.[1];
  if (!pub || !priv) throw new Error("Failed to generate age key");
  return { private: priv, public: pub };
}

export function agePublicFromPrivate(privateKey: string): string {
  const result = spawnSync("age-keygen", ["-y"], {
    input: privateKey,
    encoding: "utf-8",
  });
  if (result.status !== 0) throw new Error("Failed to derive public key from private key");
  return result.stdout.trim();
}

export function keyPath(project: string): string {
  return join(getKeysDir(), `${project.replace(/\//g, "-")}.txt`);
}

export function keyExists(project: string): boolean {
  return fs.existsSync(keyPath(project));
}

export function keySave(project: string, key: AgeKey): void {
  const path = keyPath(project);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `# project: ${project}\n# public key: ${key.public}\n${key.private}\n`, {
    mode: 0o600,
  });
}

export function keyLoad(project: string): AgeKey | null {
  const path = keyPath(project);
  if (!fs.existsSync(path)) return null;

  const content = fs.readFileSync(path, "utf-8") as string;
  const pub = content.match(/# public key: (age1[a-z0-9]+)/)?.[1];
  const priv = content.match(/(AGE-SECRET-KEY-[A-Z0-9]+)/)?.[1];

  return pub && priv ? { private: priv, public: pub } : null;
}

function parseAgeKeyReference(path: string): AgeKeyReference | null {
  const content = fs.readFileSync(path, "utf-8") as string;
  const project = content.match(/# project: (.+)/)?.[1] ?? content.match(/# repo: (.+)/)?.[1];
  const pub = content.match(/# public key: (age1[a-z0-9]+)/)?.[1];
  return project && pub ? { project, public: pub, path } : null;
}

export function findKeyByPublicKey(publicKey: string): AgeKeyReference | null {
  return findKeysByPublicKey(publicKey)[0] ?? null;
}

export function findKeysByPublicKey(publicKey: string): AgeKeyReference[] {
  const keysDir = getKeysDir();
  if (!fs.existsSync(keysDir)) return [];

  const matches: AgeKeyReference[] = [];

  for (const entry of fs.readdirSync(keysDir)) {
    if (!entry.endsWith(".txt")) {
      continue;
    }

    const parsed = parseAgeKeyReference(join(keysDir, entry));
    if (parsed?.public === publicKey) {
      matches.push(parsed);
    }
  }

  return matches;
}

export function keysList(): { project: string; public: string }[] {
  const keysDir = getKeysDir();
  if (!fs.existsSync(keysDir)) return [];

  return fs
    .readdirSync(keysDir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => parseAgeKeyReference(join(keysDir, f)))
    .filter((k): k is AgeKeyReference => k !== null)
    .map(({ project, public: publicKey }) => ({ project, public: publicKey }));
}
