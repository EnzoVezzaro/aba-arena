'use strict';

/**
 * ABA sandbox backends.
 *
 * Docker is OPTIONAL. ABA always runs benchmarks against a snapshot copy of
 * the project (the original repository is never modified). When Docker is
 * available the benchmark runs inside an isolated container; otherwise (or
 * with `--local`) it runs directly on the host inside the snapshot
 * directory — no Docker required.
 */

const { randomBytes } = require('crypto');
const { execFile } = require('child_process');

// dockerode is optional — ABA works without it (local host sandbox).
let Dockerode = null;
try {
  Dockerode = require('dockerode');
} catch {
  // Docker client not installed — local sandbox only.
}

/** Docker-backed sandbox: runs the benchmark in an isolated container. */
class Sandbox {
  constructor(config) {
    if (!Dockerode) {
      throw new Error('dockerode is not installed; use --local to run on the host');
    }
    this.backend = 'docker';
    this.docker = new Dockerode();
    this.config = config;
    this.container = null;
    this.state = {
      id: '',
      name: '',
      status: 'stopped',
    };
  }

  /** True when the Docker daemon is reachable. */
  async isAvailable() {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async start(snapshotDir, battleId) {
    const containerName = `aba-benchmark-${battleId}-${randomBytes(4).toString('hex')}`;

    await this.ensureImage();

    const container = await this.docker.createContainer({
      Image: this.config.image,
      name: containerName,
      Cmd: ['/bin/sh', '-c', 'mkdir -p /work'],
      Env: this.buildEnv(),
      NetworkingConfig: this.buildNetworkConfig(),
      HostConfig: this.buildHostConfig(),
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      ExposedPorts: {},
    });

    await container.start();
    this.container = container;
    this.state = { id: container.id, name: containerName, status: 'running' };

    await new Promise(r => setTimeout(r, 2000));

    await this.copySnapshotToContainer(container, snapshotDir);

    return {
      containerId: container.id,
      containerName,
      mountPath: '/work',
    };
  }

  buildEnv() {
    const env = [];

    if (this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        env.push(`${key}=${value}`);
      }
    }

    if (this.config.secrets) {
      for (const [key, value] of Object.entries(this.config.secrets)) {
        env.push(`${key}=***REDACTED***`);
      }
    }

    env.push(`ABA_NETWORK_POLICY=${this.config.network}`);

    return env;
  }

  buildNetworkConfig() {
    if (this.config.network === 'disabled') {
      return { EndpointID: '', NetworkMode: 'none' };
    }
    return { EndpointID: '', NetworkMode: 'default' };
  }

  buildHostConfig() {
    return {
      Binds: [],
      Memory: this.config.memLimit ? this.parseMemory(this.config.memLimit) : undefined,
      CpuQuota: this.config.cpus ? this.config.cpus * 100000 : undefined,
      PidsLimit: 512,
    };
  }

  parseMemory(memLimit) {
    const match = memLimit.match(/^(\d+)(g|m|k)?$/i);
    if (!match) return 512 * 1024 * 1024;
    const value = parseInt(match[1], 10);
    const unit = (match[2] || '').toLowerCase();
    switch (unit) {
      case 'g': return value * 1024 * 1024 * 1024;
      case 'm': return value * 1024 * 1024;
      case 'k': return Math.ceil(value * 1024);
      default: return value * 1024 * 1024;
    }
  }

  async ensureImage() {
    try {
      const image = this.config.image;
      await this.docker.getImage(image).pull();
    } catch (err) {
      throw new Error(`Failed to ensure image ${this.config.image}: ${err.message}`);
    }
  }

  async copySnapshotToContainer(container, snapshotDir) {
    const tar = await this.createSnapshotArchive(snapshotDir);
    await container.putArchive(tar);

    await container.exec({
      Cmd: ['/bin/sh', '-c', 'cd /work && tar -xzf - --strip-components=1'],
    }, {
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
    });
  }

  async createSnapshotArchive(snapshotDir) {
    return new Promise((resolve, reject) => {
      // Exclude VCS metadata and dependency/build noise: the container must
      // contain only the repository files — never .git (remotes, history,
      // host paths from worktree gitfiles) or node_modules.
      const tar = require('child_process').spawn('tar', [
        'czf', '-',
        '--exclude=.git',
        '--exclude=node_modules',
        '--exclude=dist',
        '--exclude=build',
        '--exclude=coverage',
        '-C', snapshotDir, '.',
      ]);
      const chunks = [];
      tar.stdout.on('data', (data) => chunks.push(data));
      tar.stderr.on('data', () => {});
      tar.on('close', () => resolve(Buffer.concat(chunks)));
      tar.on('error', reject);
    });
  }

  async stop(preserve) {
    if (!this.container) {
      return { exitCode: null, logs: '', artifacts: [] };
    }

    try {
      const logs = await this.container.logs({
        stdout: true,
        stderr: true,
        timestamps: false,
      });
      const logsStr = logs.toString();

      await this.container.stop();

      if (!preserve) {
        await this.container.remove({ force: true });
        this.state = { id: '', name: '', status: 'stopped' };
      } else {
        this.state = {
          id: this.container.id,
          name: this.container.name,
          status: 'stopped',
          finishedAt: new Date(),
        };
      }

      return {
        exitCode: this.container.Status ? parseInt(this.container.Status.Code, 10) : null,
        logs: logsStr,
        artifacts: [],
      };
    } catch (err) {
      this.state = { id: '', name: '', status: 'error' };
      throw err;
    }
  }

  getState() {
    return { ...this.state };
  }

  async exec(cmd) {
    if (!this.container) {
      throw new Error('No container running');
    }

    const result = await this.container.exec({
      Cmd: Array.isArray(cmd) ? cmd : [cmd],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
    });

    const { stdout, stderr } = await result.start({
      AttachStdout: true,
      AttachStderr: true,
      Raw: true,
    });

    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode: result.exitCode,
    };
  }

  async recordFingerprint() {
    if (!this.container) {
      throw new Error('No container running');
    }

    const containerInfo = await this.container.inspect();
    const os = containerInfo.Os || 'linux';
    const arch = containerInfo.Architecture || 'amd64';

    const digestMatch = (containerInfo.Config?.Image || '').match(/@sha256([a-f0-9]+)/);
    const digest = digestMatch ? digestMatch[1] : 'unknown';

    const versionResult = await this.exec('node --version');
    let runtimeVersion = 'unknown';
    if (versionResult.stdout) {
      const match = versionResult.stdout.match(/^v?(\d+\.\d+\.\d+)/m);
      if (match) {
        runtimeVersion = match[1];
      }
    }

    return {
      image: this.config.image,
      digest,
      os,
      arch,
      runtimeVersions: {
        [this.config.image]: runtimeVersion,
      },
    };
  }
}

/**
 * Host-backed sandbox: runs the benchmark directly on the machine in the
 * snapshot directory. No Docker, no container isolation — but the original
 * repository is still never modified.
 */
class LocalSandbox {
  constructor(config) {
    this.backend = 'local';
    this.config = config;
    this.snapshotDir = null;
    this.state = {
      id: 'local',
      name: 'local',
      status: 'stopped',
    };
  }

  async start(snapshotDir, battleId) {
    this.snapshotDir = snapshotDir;
    this.state = {
      id: 'local',
      name: `aba-benchmark-${battleId}`,
      status: 'running',
    };
    return {
      containerId: 'local',
      containerName: this.state.name,
      mountPath: snapshotDir,
    };
  }

  async exec(cmd) {
    if (!this.snapshotDir) {
      throw new Error('No sandbox running');
    }

    const argv = Array.isArray(cmd) ? cmd : String(cmd).split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      return { stdout: '', stderr: 'empty command', exitCode: 1 };
    }

    return new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), {
        cwd: this.snapshotDir,
        timeout: (this.config.timeout || 1800) * 1000,
        env: this.buildEnv(),
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        let exitCode = 0;
        if (err) {
          exitCode = typeof err.code === 'number' ? err.code : 1;
        }
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode,
        });
      });
    });
  }

  buildEnv() {
    // Deliberately NOT { ...process.env }: host variables (npm tokens,
    // ABA_*, API keys, the user's real HOME) must never reach commands run
    // inside a sandbox. Only a minimal, deterministic set is passed, and
    // HOME points at the sandbox so CLIs cannot read the host user's config
    // (e.g. ~/.npmrc, ~/.gitconfig).
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: this.snapshotDir || '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      TERM: 'dumb',
      NO_COLOR: '1',
    };
    if (this.config.env) {
      Object.assign(env, this.config.env);
    }
    if (this.config.secrets) {
      for (const key of Object.keys(this.config.secrets)) {
        env[key] = '***REDACTED***';
      }
    }
    env.ABA_NETWORK_POLICY = this.config.network;
    return env;
  }

  async stop(preserve) {
    this.state = preserve
      ? { id: 'local', name: this.state.name, status: 'stopped', finishedAt: new Date() }
      : { id: 'local', name: 'local', status: 'stopped' };
    return { exitCode: null, logs: '', artifacts: [] };
  }

  getState() {
    return { ...this.state };
  }

  async recordFingerprint() {
    return {
      image: this.config.image,
      digest: 'host',
      os: process.platform,
      arch: process.arch,
      runtimeVersions: {
        node: process.version,
      },
    };
  }
}

/**
 * Pick a sandbox backend.
 *
 * - opts.local forces the host backend (no Docker).
 * - Otherwise Docker is used when the client is installed AND the daemon is
 *   reachable; any failure falls back to the host backend.
 */
async function createSandbox(config, opts = {}) {
  if (opts.local) {
    return new LocalSandbox(config);
  }
  if (Dockerode) {
    const sandbox = new Sandbox(config);
    if (await sandbox.isAvailable()) {
      return sandbox;
    }
  }
  return new LocalSandbox(config);
}

module.exports = { Sandbox, LocalSandbox, createSandbox };
