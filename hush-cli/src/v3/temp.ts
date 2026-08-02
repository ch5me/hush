import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HushContext } from "../types.js";
import type { HushArtifactDescriptor } from "./artifacts.js";

export type HushSignalName = "SIGINT" | "SIGTERM";

export interface HushStagedArtifact {
  logicalPath: string;
  kind: HushArtifactDescriptor["kind"];
  path: string;
  format: string;
  sensitive: boolean;
  persisted: boolean;
}

export interface HushTempControllerOptions {
  persist: boolean;
  outputRoot?: string;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class HushTempController {
  readonly persist: boolean;
  readonly outputRoot?: string;
  readonly tempRoot: string;

  private readonly ctx: HushContext;
  private readonly signalHandlers = new Map<HushSignalName, () => void>();
  private interruptedBy: HushSignalName | null = null;
  private cleanedUp = false;

  constructor(ctx: HushContext, options: HushTempControllerOptions) {
    this.ctx = ctx;
    this.persist = options.persist;
    this.outputRoot = options.outputRoot;
    this.tempRoot = join(
      tmpdir(),
      `hush-materialize-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    );
  }

  private setPrivateRoot(): void {
    this.ctx.fs.mkdirSync(this.tempRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (existsSync(this.tempRoot)) {
      this.ctx.fs.chmodSync?.(this.tempRoot, PRIVATE_DIR_MODE);
    }
  }

  initialize(): void {
    this.setPrivateRoot();

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        this.interruptedBy = signal;
        this.cleanup();
      };

      this.signalHandlers.set(signal, handler);
      this.ctx.process.on?.(signal, handler);
    }
  }

  writeArtifact(descriptor: HushArtifactDescriptor): HushStagedArtifact {
    const baseRoot = this.persist ? (this.outputRoot ?? this.tempRoot) : this.tempRoot;
    const directory = join(baseRoot, ...descriptor.relativePath.split("/").slice(0, -1));
    const targetPath = join(baseRoot, descriptor.relativePath);

    if (existsSync(baseRoot)) {
      this.ctx.fs.chmodSync?.(baseRoot, PRIVATE_DIR_MODE);
    }

    this.ctx.fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (existsSync(directory)) {
      this.ctx.fs.chmodSync?.(directory, PRIVATE_DIR_MODE);
    }
    this.ctx.fs.writeFileSync(
      targetPath,
      descriptor.kind === "binary" ? descriptor.content : descriptor.content,
      descriptor.kind === "binary"
        ? { mode: PRIVATE_FILE_MODE }
        : { encoding: "utf-8", mode: PRIVATE_FILE_MODE },
    );

    return {
      logicalPath: descriptor.logicalPath,
      kind: descriptor.kind,
      path: targetPath,
      format: descriptor.format,
      sensitive: descriptor.sensitive,
      persisted: this.persist,
    };
  }

  getInterruptedSignal(): HushSignalName | null {
    return this.interruptedBy;
  }

  cleanup(): void {
    if (this.cleanedUp) {
      return;
    }

    this.cleanedUp = true;

    for (const [signal, handler] of this.signalHandlers.entries()) {
      this.ctx.process.removeListener?.(signal, handler);
    }

    if (!this.persist && existsSync(this.tempRoot)) {
      if (this.ctx.fs.rmSync) {
        this.ctx.fs.rmSync(this.tempRoot, { recursive: true, force: true });
      }
    }
  }
}
