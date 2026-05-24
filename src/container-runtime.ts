/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawnSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

type ContainerRuntime = 'docker' | 'podman';

function resolveContainerRuntime(): ContainerRuntime {
  const env = readEnvFile(['CONTAINER_RUNTIME']);
  const runtime = (process.env.CONTAINER_RUNTIME || env.CONTAINER_RUNTIME || '').trim();
  if (runtime === 'docker' || runtime === 'podman') return runtime;
  if (runtime) throw new Error(`Unsupported CONTAINER_RUNTIME: ${runtime}`);
  if (spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0) return 'docker';
  if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status === 0) return 'podman';
  return 'docker';
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN: ContainerRuntime = resolveContainerRuntime();

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (os.platform() !== 'linux') return [];

  // Docker does not expose host.docker.internal on Linux by default.
  if (CONTAINER_RUNTIME_BIN === 'docker') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }

  // Podman exposes host.containers.internal/host.docker.internal through its own host-gateway handling.
  // Passing Docker-only host-gateway flags can cause inconsistencies, so we let Podman handle this itself.
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error(
      `║  1. Ensure ${CONTAINER_RUNTIME_BIN} is installed and running${' '.repeat(Math.max(0, 18 - CONTAINER_RUNTIME_BIN.length))}║`,
    );
    console.error(
      `║  2. Run: ${CONTAINER_RUNTIME_BIN} info${' '.repeat(Math.max(0, 49 - CONTAINER_RUNTIME_BIN.length))}║`,
    );
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
