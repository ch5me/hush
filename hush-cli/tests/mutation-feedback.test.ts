import { describe, expect, it } from 'vitest';
import { suggestKnownName, withSuggestion } from '../src/commands/mutation-feedback.js';

describe('mutation spelling feedback', () => {
  it('suggests one unambiguous close spelling without changing it', () => {
    expect(suggestKnownName('env/project/produciton', [
      'env/project/shared',
      'env/project/production',
    ])).toBe('env/project/production');
  });

  it('does not suggest when the closest spelling is ambiguous', () => {
    expect(suggestKnownName('prod', ['prad', 'pred'])).toBeUndefined();
  });

  it('states the suggestion as guidance, not an applied correction', () => {
    expect(withSuggestion(
      'File "env/project/produciton" is not declared. Nothing was changed.',
      'env/project/produciton',
      ['env/project/production'],
    )).toBe('File "env/project/produciton" is not declared. Nothing was changed. Did you mean "env/project/production"?');
  });
});
