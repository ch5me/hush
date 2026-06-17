import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getProjectIdentifier } from '../src/project.js';

const roots: string[] = [];

function writePackage(repository: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'hush-project-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ repository }), 'utf-8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('getProjectIdentifier', () => {
  it('detects a project from a Forgejo HTTPS repository URL', () => {
    const root = writePackage({ url: 'git+https://git.ch5.me/ch5/hush.git' });

    expect(getProjectIdentifier(root)).toBe('ch5/hush');
  });

  it('keeps supporting GitHub HTTPS repository URLs', () => {
    const root = writePackage('https://github.com/ch5me/hush.git');

    expect(getProjectIdentifier(root)).toBe('ch5me/hush');
  });

  it('detects a project from scp-style Git URLs', () => {
    const root = writePackage('git@git.ch5.me:ch5/hush.git');

    expect(getProjectIdentifier(root)).toBe('ch5/hush');
  });
});
