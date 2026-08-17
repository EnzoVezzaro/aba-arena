import { describe, it, expect } from 'vitest';
import { createSnapshotHash, parseGithubRepo, copyDirectory } from '../importer.cjs';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('createSnapshotHash', () => {
  it('returns a hex string', () => {
    const hash = createSnapshotHash('/test', 'abc123');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns different hashes for different commit SHAs', () => {
    const hash1 = createSnapshotHash('/test', 'abc123');
    const hash2 = createSnapshotHash('/test', 'def456');
    expect(hash1).not.toBe(hash2);
  });

  it('returns same hash for same inputs', () => {
    const hash1 = createSnapshotHash('/test', 'abc123');
    const hash2 = createSnapshotHash('/test', 'abc123');
    expect(hash1).toBe(hash2);
  });
});

describe('parseGithubRepo', () => {
  it('parses owner/repo format', () => {
    const result = parseGithubRepo('user/repo');
    expect(result).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('parses full GitHub URL', () => {
    const result = parseGithubRepo('https://github.com/user/repo');
    expect(result).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('parses URL with trailing slash', () => {
    const result = parseGithubRepo('https://github.com/user/repo/');
    expect(result).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('parses URL with .git extension', () => {
    const result = parseGithubRepo('https://github.com/user/repo.git');
    expect(result).toEqual({ owner: 'user', repo: 'repo.git' });
  });

  it('throws on invalid input', () => {
    expect(() => parseGithubRepo('invalid')).toThrow('Invalid GitHub repository specification');
  });

  it('throws on single word input', () => {
    expect(() => parseGithubRepo('norepo')).toThrow('Invalid GitHub repository specification');
  });

  it('handles github.com prefix', () => {
    const result = parseGithubRepo('github.com/user/repo');
    expect(result).toEqual({ owner: 'user', repo: 'repo' });
  });
});

describe('copyDirectory', () => {
  const testDir = join(tmpdir(), 'aba-test-copy-' + Date.now());
  const srcDir = join(testDir, 'src');
  const destDir = join(testDir, 'dest');

  beforeEach(() => {
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('copies files recursively', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    mkdirSync(join(srcDir, 'subdir'));
    writeFileSync(join(srcDir, 'subdir', 'nested.txt'), 'world');

    copyDirectory(srcDir, join(destDir, 'copy'));

    expect(existsSync(join(destDir, 'copy', 'file.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'copy', 'subdir', 'nested.txt'))).toBe(true);
  });

  it('skips .git directory', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    mkdirSync(join(srcDir, '.git'));
    writeFileSync(join(srcDir, '.git', 'config'), 'git config');

    copyDirectory(srcDir, join(destDir, 'copy'));

    expect(existsSync(join(destDir, 'copy', 'file.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'copy', '.git'))).toBe(false);
  });

  it('skips node_modules directory', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    mkdirSync(join(srcDir, 'node_modules'));
    writeFileSync(join(srcDir, 'node_modules', 'package.js'), 'module');

    copyDirectory(srcDir, join(destDir, 'copy'));

    expect(existsSync(join(destDir, 'copy', 'file.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'copy', 'node_modules'))).toBe(false);
  });

  it('skips large binary files when skipLargeBinary is true', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    writeFileSync(join(srcDir, 'image.mp3'), 'binary data');

    copyDirectory(srcDir, join(destDir, 'copy'), true);

    expect(existsSync(join(destDir, 'copy', 'file.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'copy', 'image.mp3'))).toBe(false);
  });

  it('does not skip binary files when skipLargeBinary is false', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    writeFileSync(join(srcDir, 'image.mp3'), 'binary data');

    copyDirectory(srcDir, join(destDir, 'copy'), false);

    expect(existsSync(join(destDir, 'copy', 'file.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'copy', 'image.mp3'))).toBe(true);
  });

  it('creates destination directory if it does not exist', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    const newDest = join(destDir, 'new', 'nested', 'copy');

    copyDirectory(srcDir, newDest);

    expect(existsSync(join(newDest, 'file.txt'))).toBe(true);
  });

  it('does nothing if source is not a directory', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'hello');
    const notDir = join(testDir, 'notdir.txt');
    writeFileSync(notDir, 'not a dir');

    copyDirectory(notDir, join(destDir, 'copy'));

    expect(existsSync(join(destDir, 'copy'))).toBe(false);
  });
});
