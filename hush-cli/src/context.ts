import { spawnSync, execSync } from "node:child_process";
import { join } from "node:path";

import pc from "picocolors";

import { loadConfig, findProjectRoot } from "./config/loader.js";
import {
  decrypt,
  decryptYaml,
  encrypt,
  encryptYaml,
  encryptYamlContent,
  edit,
  isSopsInstalled,
} from "./core/sops.js";
import {
  ageAvailable,
  ageGenerate,
  agePublicFromPrivate,
  keyExists,
  keySave,
  keyLoad,
  keyPath,
} from "./lib/age.js";
import { fs } from "./lib/fs.js";
import type { HushContext } from "./types.js";

export const defaultContext: HushContext = {
  fs,
  path: {
    join,
  },
  exec: {
    spawnSync: (command, args, options) => {
      return spawnSync(command, args, options);
    },
    execSync: (command, options) => {
      return execSync(command, options);
    },
  },
  logger: {
    log: (message) => console.log(message),
    error: (message) => console.error(pc.red(message)),
    warn: (message) => console.warn(pc.yellow(message)),
    info: (message) => console.info(pc.blue(message)),
  },
  process: {
    cwd: () => process.cwd(),
    exit: (code) => process.exit(code),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    on: (event, listener) => void process.on(event, listener),
    removeListener: (event, listener) => void process.removeListener(event, listener),
  },
  network: {
    fetch: (...args) => fetch(...args),
  },
  config: {
    loadConfig,
    findProjectRoot,
  },
  age: {
    ageAvailable,
    ageGenerate,
    keyExists,
    keySave,
    keyPath,
    keyLoad,
    agePublicFromPrivate,
  },
  sops: {
    decrypt,
    decryptYaml,
    encrypt,
    encryptYaml,
    encryptYamlContent,
    edit,
    isSopsInstalled,
  },
};
