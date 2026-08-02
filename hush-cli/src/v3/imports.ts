import type { HushV3Repository } from "../types.js";
import {
  type HushBundleName,
  type HushFileIndexEntry,
  type HushImportName,
  type HushProvenanceImportRecord,
} from "./domain.js";

export interface HushSelectedFileCandidate {
  file: HushFileIndexEntry;
  repository: HushV3Repository;
  precedence: number;
  bundleName: HushBundleName;
  importRecord?: HushProvenanceImportRecord;
}

export interface HushImportRepositoryMap {
  [importName: string]: HushV3Repository;
}

export interface CollectBundleCandidatesOptions {
  repository: HushV3Repository;
  bundleName: HushBundleName;
  importedRepositories?: HushImportRepositoryMap;
  localPrecedence: number;
  importedPrecedence: number;
}

interface BundleTraversalContext {
  repository: HushV3Repository;
  bundleName: HushBundleName;
  precedence: number;
  importedRepositories: HushImportRepositoryMap;
  importRecord?: HushProvenanceImportRecord;
  stack: string[];
}

function toBundleLookupCandidates(repository: HushV3Repository, reference: string): string[] {
  const candidates = new Set<string>([reference]);

  if (reference.startsWith("bundles/")) {
    candidates.add(reference.slice("bundles/".length));
  }

  const lastSegment = reference.split("/").filter(Boolean).pop();
  if (lastSegment) {
    candidates.add(lastSegment);
  }

  return Array.from(candidates).filter(
    (candidate) => candidate in (repository.manifest.bundles ?? {}),
  );
}

function requireBundleDefinition(repository: HushV3Repository, bundleName: string) {
  const bundle = repository.manifest.bundles?.[bundleName];

  if (!bundle) {
    throw new Error(
      `Bundle "${bundleName}" is not declared in repository ${repository.projectRoot}`,
    );
  }

  return bundle;
}

function requireImportedRepository(
  repository: HushV3Repository,
  importedRepositories: HushImportRepositoryMap,
  importName: HushImportName,
): { importedRepository: HushV3Repository; projectName: string } {
  const importDefinition = repository.manifest.imports?.[importName];

  if (!importDefinition) {
    throw new Error(
      `Import "${importName}" is not declared in repository ${repository.projectRoot}`,
    );
  }

  const importedRepository = importedRepositories[importName];

  if (!importedRepository) {
    throw new Error(
      `Import "${importName}" requires an imported repository object during resolution`,
    );
  }

  return {
    importedRepository,
    projectName: importDefinition.project,
  };
}

function assertPullAllowed(
  repository: HushV3Repository,
  importName: HushImportName,
  kind: "bundle" | "file",
  reference: string,
): void {
  const importDefinition = repository.manifest.imports?.[importName];

  if (!importDefinition) {
    throw new Error(
      `Import "${importName}" is not declared in repository ${repository.projectRoot}`,
    );
  }

  const allowed =
    kind === "bundle" ? (importDefinition.pull.bundles ?? []) : (importDefinition.pull.files ?? []);

  if (!allowed.includes(reference)) {
    throw new Error(
      `Import "${importName}" cannot pull ${kind} "${reference}" because it is not declared in imports.pull.${kind}s`,
    );
  }
}

function fileCandidateFromIndex(
  file: HushFileIndexEntry,
  repository: HushV3Repository,
  precedence: number,
  bundleName: HushBundleName,
  importRecord?: HushProvenanceImportRecord,
): HushSelectedFileCandidate {
  return {
    file,
    repository,
    precedence,
    bundleName,
    importRecord,
  };
}

function collectBundleCandidatesInternal(
  context: BundleTraversalContext,
): HushSelectedFileCandidate[] {
  const visitKey = `${context.repository.projectRoot}::${context.bundleName}`;

  if (context.stack.includes(visitKey)) {
    throw new Error(`Bundle import cycle detected: ${[...context.stack, visitKey].join(" -> ")}`);
  }

  const bundle = requireBundleDefinition(context.repository, context.bundleName);
  const nextStack = [...context.stack, visitKey];
  const directFiles = (bundle.files ?? []).flatMap((fileRef) => {
    const file = context.repository.filesByPath[fileRef.path];

    if (!file) {
      throw new Error(`Bundle "${context.bundleName}" references missing file "${fileRef.path}"`);
    }

    return fileCandidateFromIndex(
      file,
      context.repository,
      context.precedence,
      context.bundleName,
      context.importRecord,
    );
  });

  const importedEntries = (bundle.imports ?? []).flatMap((bundleImport) => {
    if (bundleImport.project) {
      const { importedRepository, projectName } = requireImportedRepository(
        context.repository,
        context.importedRepositories,
        bundleImport.project,
      );

      if (bundleImport.bundle) {
        assertPullAllowed(context.repository, bundleImport.project, "bundle", bundleImport.bundle);
        const bundleCandidates = toBundleLookupCandidates(importedRepository, bundleImport.bundle);

        if (bundleCandidates.length === 0) {
          throw new Error(
            `Imported bundle reference "${bundleImport.bundle}" from import "${bundleImport.project}" does not match any bundle in ${importedRepository.projectRoot}`,
          );
        }

        return collectBundleCandidatesInternal({
          repository: importedRepository,
          bundleName: bundleCandidates[0]!,
          precedence: context.precedence,
          importedRepositories: context.importedRepositories,
          importRecord: {
            project: projectName,
            bundle: bundleImport.bundle,
          },
          stack: nextStack,
        });
      }

      if (bundleImport.file) {
        assertPullAllowed(context.repository, bundleImport.project, "file", bundleImport.file);
        const importedFile = importedRepository.filesByPath[bundleImport.file];

        if (!importedFile) {
          throw new Error(
            `Imported file reference "${bundleImport.file}" from import "${bundleImport.project}" does not exist in ${importedRepository.projectRoot}`,
          );
        }

        return fileCandidateFromIndex(
          importedFile,
          importedRepository,
          context.precedence,
          context.bundleName,
          {
            project: projectName,
            file: bundleImport.file,
          },
        );
      }

      return [];
    }

    if (bundleImport.bundle) {
      const bundleCandidates = toBundleLookupCandidates(context.repository, bundleImport.bundle);

      if (bundleCandidates.length === 0) {
        throw new Error(
          `Bundle "${context.bundleName}" imports missing local bundle "${bundleImport.bundle}"`,
        );
      }

      return collectBundleCandidatesInternal({
        repository: context.repository,
        bundleName: bundleCandidates[0]!,
        precedence: context.precedence,
        importedRepositories: context.importedRepositories,
        importRecord: context.importRecord,
        stack: nextStack,
      });
    }

    if (bundleImport.file) {
      const importedFile = context.repository.filesByPath[bundleImport.file];

      if (!importedFile) {
        throw new Error(
          `Bundle "${context.bundleName}" imports missing local file "${bundleImport.file}"`,
        );
      }

      return fileCandidateFromIndex(
        importedFile,
        context.repository,
        context.precedence,
        context.bundleName,
        context.importRecord,
      );
    }

    return [];
  });

  const combined = [...directFiles, ...importedEntries];
  const selectors = bundle.paths ?? [];

  if (selectors.length === 0) {
    return combined;
  }

  return combined.filter((candidate) =>
    selectors.some((selector) =>
      candidate.file.logicalPaths.some(
        (path) => path === selector || path.startsWith(`${selector}/`),
      ),
    ),
  );
}

export function collectBundleCandidates(
  options: CollectBundleCandidatesOptions,
): HushSelectedFileCandidate[] {
  const bundle = requireBundleDefinition(options.repository, options.bundleName);
  const importedRepositories = options.importedRepositories ?? {};
  const localCandidates = (bundle.files ?? []).flatMap((fileRef) => {
    const file = options.repository.filesByPath[fileRef.path];

    if (!file) {
      throw new Error(`Bundle "${options.bundleName}" references missing file "${fileRef.path}"`);
    }

    return fileCandidateFromIndex(
      file,
      options.repository,
      options.localPrecedence,
      options.bundleName,
    );
  });

  const importedCandidates = (bundle.imports ?? []).flatMap((bundleImport) => {
    if (bundleImport.project) {
      const { importedRepository, projectName } = requireImportedRepository(
        options.repository,
        importedRepositories,
        bundleImport.project,
      );

      if (bundleImport.bundle) {
        assertPullAllowed(options.repository, bundleImport.project, "bundle", bundleImport.bundle);
        const bundleCandidates = toBundleLookupCandidates(importedRepository, bundleImport.bundle);

        if (bundleCandidates.length === 0) {
          throw new Error(
            `Imported bundle reference "${bundleImport.bundle}" from import "${bundleImport.project}" does not match any bundle in ${importedRepository.projectRoot}`,
          );
        }

        return collectBundleCandidatesInternal({
          repository: importedRepository,
          bundleName: bundleCandidates[0]!,
          precedence: options.importedPrecedence,
          importedRepositories,
          importRecord: {
            project: projectName,
            bundle: bundleImport.bundle,
          },
          stack: [`${options.repository.projectRoot}::${options.bundleName}`],
        });
      }

      if (bundleImport.file) {
        assertPullAllowed(options.repository, bundleImport.project, "file", bundleImport.file);
        const importedFile = importedRepository.filesByPath[bundleImport.file];

        if (!importedFile) {
          throw new Error(
            `Imported file reference "${bundleImport.file}" from import "${bundleImport.project}" does not exist in ${importedRepository.projectRoot}`,
          );
        }

        return fileCandidateFromIndex(
          importedFile,
          importedRepository,
          options.importedPrecedence,
          options.bundleName,
          {
            project: projectName,
            file: bundleImport.file,
          },
        );
      }

      return [];
    }

    if (bundleImport.bundle) {
      const bundleCandidates = toBundleLookupCandidates(options.repository, bundleImport.bundle);

      if (bundleCandidates.length === 0) {
        throw new Error(
          `Bundle "${options.bundleName}" imports missing local bundle "${bundleImport.bundle}"`,
        );
      }

      return collectBundleCandidatesInternal({
        repository: options.repository,
        bundleName: bundleCandidates[0]!,
        precedence: options.importedPrecedence,
        importedRepositories,
        stack: [`${options.repository.projectRoot}::${options.bundleName}`],
      });
    }

    if (bundleImport.file) {
      const importedFile = options.repository.filesByPath[bundleImport.file];

      if (!importedFile) {
        throw new Error(
          `Bundle "${options.bundleName}" imports missing local file "${bundleImport.file}"`,
        );
      }

      return fileCandidateFromIndex(
        importedFile,
        options.repository,
        options.importedPrecedence,
        options.bundleName,
      );
    }

    return [];
  });

  const selectors = bundle.paths ?? [];
  const combined = [...localCandidates, ...importedCandidates];

  if (selectors.length === 0) {
    return combined;
  }

  return combined.filter((candidate) =>
    selectors.some((selector) =>
      candidate.file.logicalPaths.some(
        (path) => path === selector || path.startsWith(`${selector}/`),
      ),
    ),
  );
}

export function collectAllRepositoryPaths(
  repository: HushV3Repository,
  importedRepositories: HushImportRepositoryMap,
): Record<string, { readableFiles: Set<string>; unreadableFiles: Set<string> }> {
  const pathState: Record<string, { readableFiles: Set<string>; unreadableFiles: Set<string> }> =
    {};

  for (const candidateRepository of [repository, ...Object.values(importedRepositories)]) {
    for (const file of Object.values(candidateRepository.filesByPath)) {
      for (const logicalPath of file.logicalPaths) {
        pathState[logicalPath] ??= {
          readableFiles: new Set<string>(),
          unreadableFiles: new Set<string>(),
        };
      }
    }
  }

  return pathState;
}
