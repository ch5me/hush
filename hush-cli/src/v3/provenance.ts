import type {
  HushBundleName,
  HushFileEntry,
  HushFilePath,
  HushIdentityName,
  HushLogicalPath,
  HushProvenanceRecord,
  HushResolvedValue,
  HushTargetName,
} from "./domain.js";

export interface HushInterpolationDependency {
  path: HushLogicalPath;
  filePath?: HushFilePath;
  readable: boolean;
}

export interface HushResolvedNode extends HushResolvedValue {
  resolvedFrom: HushFilePath[];
  interpolation: {
    dependencies: HushInterpolationDependency[];
  } | null;
}

export interface HushBundleConflictDetail {
  path: HushLogicalPath;
  precedence: number;
  contenders: HushProvenanceRecord[];
}

export interface HushBundleResolution {
  identity: HushIdentityName;
  bundle: HushBundleName;
  target?: HushTargetName;
  values: Record<HushLogicalPath, HushResolvedNode>;
  artifacts: Record<HushLogicalPath, HushResolvedNode>;
  files: HushFilePath[];
  unreadableFiles: HushFilePath[];
  conflicts: HushBundleConflictDetail[];
}

export interface HushTargetResolution extends HushBundleResolution {
  target: HushTargetName;
}

export interface HushSelectedEntryCandidate {
  path: HushLogicalPath;
  entry: HushFileEntry;
  precedence: number;
  provenance: HushProvenanceRecord[];
}

export function dedupeProvenance(records: readonly HushProvenanceRecord[]): HushProvenanceRecord[] {
  const seen = new Set<string>();
  const deduped: HushProvenanceRecord[] = [];

  for (const record of records) {
    const key = JSON.stringify(record);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(record);
  }

  return deduped;
}

export function withResolvedEntry(
  candidate: HushSelectedEntryCandidate,
  entry: HushFileEntry,
  interpolation: HushResolvedNode["interpolation"],
): HushResolvedNode {
  return {
    path: candidate.path,
    entry,
    provenance: dedupeProvenance(candidate.provenance),
    resolvedFrom: Array.from(new Set(candidate.provenance.map((record) => record.filePath))),
    interpolation,
  };
}
