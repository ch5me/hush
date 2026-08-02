import type { HushArtifactEntry, HushFileEntry, HushScalarValue } from "./domain.js";
import type {
  HushInterpolationDependency,
  HushResolvedNode,
  HushSelectedEntryCandidate,
} from "./provenance.js";
import { dedupeProvenance, withResolvedEntry } from "./provenance.js";

const INTERPOLATION_PATTERN = /\$\{([^}]+)\}/g;

interface GlobalPathState {
  readableFiles: Set<string>;
  unreadableFiles: Set<string>;
}

export interface InterpolateCandidatesOptions {
  candidates: Record<string, HushSelectedEntryCandidate>;
  globalPathState: Record<string, GlobalPathState>;
}

interface ResolutionState {
  resolved: Map<string, HushResolvedNode>;
  visiting: Set<string>;
}

function isArtifactEntry(entry: HushFileEntry): entry is HushArtifactEntry {
  return "type" in entry;
}

function renderInterpolatedValue(value: HushScalarValue): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function interpolateString(
  value: string,
  currentPath: string,
  options: InterpolateCandidatesOptions,
  state: ResolutionState,
  dependencies: Map<string, HushInterpolationDependency>,
): { value: string; provenance: HushSelectedEntryCandidate["provenance"] } {
  const referencedProvenance: HushSelectedEntryCandidate["provenance"] = [];

  const interpolated = value.replace(INTERPOLATION_PATTERN, (_match, rawReference: string) => {
    const reference = rawReference.trim();
    const resolvedDependency = resolveCandidate(reference, options, state);

    dependencies.set(reference, {
      path: reference,
      filePath: resolvedDependency.resolvedFrom[0],
      readable: true,
    });
    referencedProvenance.push(...resolvedDependency.provenance);

    const resolvedValue = isArtifactEntry(resolvedDependency.entry)
      ? (resolvedDependency.entry.value ?? "")
      : resolvedDependency.entry.value;

    if (
      typeof resolvedValue !== "string" &&
      typeof resolvedValue !== "number" &&
      typeof resolvedValue !== "boolean" &&
      resolvedValue !== null
    ) {
      throw new Error(
        `Interpolation source "${reference}" for "${currentPath}" must resolve to a scalar or stringifiable value`,
      );
    }

    return renderInterpolatedValue(resolvedValue as HushScalarValue);
  });

  return {
    value: interpolated,
    provenance: referencedProvenance,
  };
}

function resolveScalarValue(
  value: HushScalarValue,
  currentPath: string,
  options: InterpolateCandidatesOptions,
  state: ResolutionState,
  dependencies: Map<string, HushInterpolationDependency>,
): { value: HushScalarValue; provenance: HushSelectedEntryCandidate["provenance"] } {
  if (typeof value === "string") {
    return interpolateString(value, currentPath, options, state, dependencies);
  }

  if (Array.isArray(value)) {
    const provenance: HushSelectedEntryCandidate["provenance"] = [];
    const resolvedItems = value.map((item) => {
      const resolved = resolveScalarValue(item, currentPath, options, state, dependencies);
      provenance.push(...resolved.provenance);
      return resolved.value;
    });

    return { value: resolvedItems, provenance };
  }

  if (value && typeof value === "object") {
    const provenance: HushSelectedEntryCandidate["provenance"] = [];
    const resolvedEntries = Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => {
        const resolved = resolveScalarValue(nestedValue, currentPath, options, state, dependencies);
        provenance.push(...resolved.provenance);
        return [key, resolved.value];
      }),
    );

    return { value: resolvedEntries, provenance };
  }

  return { value, provenance: [] };
}

function resolveEntry(
  candidate: HushSelectedEntryCandidate,
  options: InterpolateCandidatesOptions,
  state: ResolutionState,
): HushResolvedNode {
  const dependencies = new Map<string, HushInterpolationDependency>();

  if (isArtifactEntry(candidate.entry)) {
    if (candidate.entry.value === undefined) {
      return withResolvedEntry(candidate, candidate.entry, null);
    }

    const resolved = interpolateString(
      candidate.entry.value,
      candidate.path,
      options,
      state,
      dependencies,
    );

    return withResolvedEntry(
      {
        ...candidate,
        provenance: dedupeProvenance([...candidate.provenance, ...resolved.provenance]),
      },
      {
        ...candidate.entry,
        value: resolved.value,
      },
      dependencies.size > 0 ? { dependencies: Array.from(dependencies.values()) } : null,
    );
  }

  const resolved = resolveScalarValue(
    candidate.entry.value,
    candidate.path,
    options,
    state,
    dependencies,
  );

  return withResolvedEntry(
    {
      ...candidate,
      provenance: dedupeProvenance([...candidate.provenance, ...resolved.provenance]),
    },
    {
      ...candidate.entry,
      value: resolved.value,
    },
    dependencies.size > 0 ? { dependencies: Array.from(dependencies.values()) } : null,
  );
}

function resolveCandidate(
  path: string,
  options: InterpolateCandidatesOptions,
  state: ResolutionState,
): HushResolvedNode {
  const cached = state.resolved.get(path);

  if (cached) {
    return cached;
  }

  if (state.visiting.has(path)) {
    throw new Error(`Interpolation cycle detected at "${path}"`);
  }

  const candidate = options.candidates[path];

  if (!candidate) {
    const pathState = options.globalPathState[path];

    if (pathState && pathState.unreadableFiles.size > 0) {
      const unreadableFile = Array.from(pathState.unreadableFiles).sort()[0];
      throw new Error(
        `Interpolation source "${path}" is unreadable because file "${unreadableFile}" is not readable by the active identity`,
      );
    }

    if (pathState && pathState.readableFiles.size > 0) {
      throw new Error(
        `Interpolation source "${path}" is not included in the resolved bundle or target graph`,
      );
    }

    throw new Error(`Interpolation source "${path}" does not exist in the repository graph`);
  }

  state.visiting.add(path);

  try {
    const resolved = resolveEntry(candidate, options, state);
    state.resolved.set(path, resolved);
    return resolved;
  } finally {
    state.visiting.delete(path);
  }
}

export function interpolateCandidates(
  options: InterpolateCandidatesOptions,
): Record<string, HushResolvedNode> {
  const state: ResolutionState = {
    resolved: new Map<string, HushResolvedNode>(),
    visiting: new Set<string>(),
  };

  for (const path of Object.keys(options.candidates)) {
    resolveCandidate(path, options, state);
  }

  return Object.fromEntries(state.resolved.entries());
}
