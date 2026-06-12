import { describe, it, expect } from 'vitest';
import { maskValue, maskVars, formatMaskedVar } from '../../src/core/mask.js';

describe('maskValue', () => {
  it('masks empty value as not set', () => {
    expect(maskValue('')).toBe('(not set)');
  });

  it('redacts to a fixed width regardless of length', () => {
    expect(maskValue('abc')).toBe('********');
    expect(maskValue('abcdefgh')).toBe('********');
    expect(maskValue('x'.repeat(200))).toBe('********');
  });

  it('never reveals a prefix of the value', () => {
    const masked = maskValue('sk_test_1234567890abcdef');
    expect(masked).not.toContain('sk');
    expect(masked).toBe('********');
  });

  it('never reveals the exact length of the value', () => {
    expect(maskValue('short')).toBe(maskValue('a-much-longer-secret-value'));
  });
});

describe('maskVars', () => {
  it('masks all variables and reports isSet', () => {
    const vars = [
      { key: 'SHORT', value: 'abc' },
      { key: 'LONG', value: 'sk_test_1234567890' },
      { key: 'EMPTY', value: '' },
    ];
    const result = maskVars(vars);

    expect(result).toEqual([
      { key: 'SHORT', masked: '********', isSet: true },
      { key: 'LONG', masked: '********', isSet: true },
      { key: 'EMPTY', masked: '(not set)', isSet: false },
    ]);
  });
});

describe('formatMaskedVar', () => {
  it('formats set variable without leaking length', () => {
    const result = formatMaskedVar({ key: 'API_KEY', masked: '********', isSet: true }, 10);
    expect(result).toBe('API_KEY    = ********');
  });

  it('formats unset variable', () => {
    const result = formatMaskedVar({ key: 'MISSING', masked: '(not set)', isSet: false }, 10);
    expect(result).toBe('MISSING    = (not set)');
  });
});
