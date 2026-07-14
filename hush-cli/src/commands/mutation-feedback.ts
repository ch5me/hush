export function suggestKnownName(requested: string, candidates: readonly string[]): string | undefined {
  const normalized = requested.trim().toLowerCase();
  if (!normalized || candidates.length === 0) return undefined;

  const distance = (left: string, right: string): number => {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        current[rightIndex] = Math.min(
          current[rightIndex - 1]! + 1,
          previous[rightIndex]! + 1,
          previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[right.length]!;
  };

  const ranked = candidates
    .map((candidate) => ({ candidate, distance: distance(normalized, candidate.toLowerCase()) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
  const best = ranked[0];
  const second = ranked[1];
  const threshold = Math.max(1, Math.floor(normalized.length / 3));
  return best && best.distance <= threshold && (!second || best.distance < second.distance)
    ? best.candidate
    : undefined;
}

export function withSuggestion(message: string, requested: string, candidates: readonly string[]): string {
  const suggestion = suggestKnownName(requested, candidates);
  return suggestion ? `${message} Did you mean "${suggestion}"?` : message;
}
