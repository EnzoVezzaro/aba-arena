import { describe, it, expect } from 'vitest';
import { LocalSandbox, createSandbox } from '../sandbox.cjs';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('LocalSandbox', () => {
  const testDir = join(tmpdir(), 'aba-sandbox-test-' + Date.now());
  const snapshotDir = join(testDir, 'snapshot');

  beforeEach(() => {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'test.txt'), 'hello');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates with local backend', () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    expect(sandbox.backend).toBe('local');
  });

  it('starts with snapshot directory', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    const result = await sandbox.start(snapshotDir, 'test-battle');
    expect(result.containerId).toBe('local');
    expect(result.mountPath).toBe(snapshotDir);
  });

  it('runs commands in sandbox', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted', timeout: 10 });
    await sandbox.start(snapshotDir, 'test-battle');
    const result = await sandbox.exec(['echo', 'hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns error for empty command', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    const result = await sandbox.exec([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('empty command');
  });

  it('throws when no sandbox running', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await expect(sandbox.exec(['echo', 'test'])).rejects.toThrow('No sandbox running');
  });

  it('stops sandbox', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    const result = await sandbox.stop(false);
    expect(result).toBeDefined();
  });

  it('preserves sandbox state when preserve is true', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    await sandbox.stop(true);
    const state = sandbox.getState();
    expect(state.status).toBe('stopped');
    expect(state.finishedAt).toBeDefined();
  });

  it('gets state', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    const state = sandbox.getState();
    expect(state.id).toBe('local');
    expect(state.status).toBe('running');
  });

  it('records fingerprint', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    const fingerprint = await sandbox.recordFingerprint();
    expect(fingerprint.image).toBe('node:24');
    expect(fingerprint.digest).toBe('host');
    expect(fingerprint.os).toBeDefined();
    expect(fingerprint.arch).toBeDefined();
  });

  it('builds clean environment', async () => {
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    const env = sandbox.buildEnv();
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBe(snapshotDir);
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.NO_COLOR).toBe('1');
    expect(env.ABA_NETWORK_POLICY).toBe('restricted');
  });

  it('does not leak host environment', async () => {
    process.env.SECRET_KEY = 'should-not-leak';
    const sandbox = new LocalSandbox({ image: 'node:24', network: 'restricted' });
    await sandbox.start(snapshotDir, 'test-battle');
    const env = sandbox.buildEnv();
    expect(env.SECRET_KEY).toBeUndefined();
    delete process.env.SECRET_KEY;
  });

  it('includes custom env vars', async () => {
    const sandbox = new LocalSandbox({
      image: 'node:24',
      network: 'restricted',
      env: { CUSTOM_VAR: 'custom_value' },
    });
    await sandbox.start(snapshotDir, 'test-battle');
    const env = sandbox.buildEnv();
    expect(env.CUSTOM_VAR).toBe('custom_value');
  });

  it('redacts secrets', async () => {
    const sandbox = new LocalSandbox({
      image: 'node:24',
      network: 'restricted',
      secrets: { API_KEY: 'secret123' },
    });
    await sandbox.start(snapshotDir, 'test-battle');
    const env = sandbox.buildEnv();
    expect(env.API_KEY).toBe('***REDACTED***');
  });
});

describe('createSandbox', () => {
  it('creates LocalSandbox when local option is true', async () => {
    const sandbox = await createSandbox(
      { image: 'node:24', network: 'restricted' },
      { local: true }
    );
    expect(sandbox).toBeInstanceOf(LocalSandbox);
  });

  it('creates LocalSandbox as fallback', async () => {
    const sandbox = await createSandbox({ image: 'node:24', network: 'restricted' });
    expect(sandbox).toBeInstanceOf(LocalSandbox);
  });
});
