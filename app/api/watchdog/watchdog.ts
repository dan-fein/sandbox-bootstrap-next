import { get } from '@vercel/edge-config';
import { Sandbox } from '@vercel/sandbox';
import { PassThrough } from 'node:stream';
import pRetry from 'p-retry';
import { monitoringRoutesDisabled } from '../_lib/monitoringToggle';

const HEALTH_ENDPOINT = '/api/health';
const KEEPALIVE_ENDPOINT = '/internal/keepalive';
const ROTATION_INTERVAL_MS = 5 * 60 * 60 * 1000; // 5 hourss
const HEALTH_TIMEOUT_MS = 8_000;
const DRAIN_GRACE_MS = 10 * 60 * 1000; // 10 minutes

const EDGE_CONFIG_ID = env('EDGE_CONFIG_ID');
const EDGE_CONFIG_TOKEN = env('EDGE_CONFIG_TOKEN');
const SANDBOX_APP_REPO = env('SANDBOX_APP_REPO');
const SANDBOX_APP_REF = process.env.SANDBOX_APP_REF ?? 'main';
const SANDBOX_KEEPALIVE_TOKEN = env('KEEPALIVE_TOKEN');
const SANDBOX_START_PORT = process.env.SANDBOX_PORT ?? '3000';
const SANDBOX_WORKDIR = process.env.SANDBOX_WORKDIR ?? '/tmp/next-sandbox-app';
const SANDBOX_START_PORT_NUMBER = parsePort(SANDBOX_START_PORT);
const SANDBOX_CREDENTIALS = getSandboxCredentials();
const EDGE_CONFIG_KEYS = {
  active: 'sandbox_active_url',
  lastKnownGood: 'sandbox_last_known_good_url',
  previous: 'sandbox_previous_url',
  state: 'sandbox_state',
} as const;

const LEGACY_EDGE_CONFIG_KEYS = {
  active: 'sandbox.activeUrl',
  lastKnownGood: 'sandbox.lastKnownGoodUrl',
  previous: 'sandbox.previousUrl',
  state: 'sandbox.state',
} as const;

export const config = {
  runtime: 'nodejs20.x',
  schedule: '*/5 * * * *',
};

type SandboxRecord = {
  id: string;
  url: string;
  createdAt: string;
  status: 'provisioning' | 'healthy' | 'unhealthy';
};

type DrainingSandboxRecord = SandboxRecord & {
  drainStartedAt: string;
};

type SandboxState = {
  active?: SandboxRecord;
  draining: DrainingSandboxRecord[];
  lastRotationAt?: string | null;
  lastCheckAt?: string | null;
  lastFailure?: { reason: string; at: string } | null;
};

type SandboxCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

type SandboxHealth =
  | { healthy: true; payload: Record<string, unknown> }
  | { healthy: false; reason: string };

const DEFAULT_STATE: SandboxState = {
  draining: [],
};

type WatchdogOptions = {
  forceProvision?: boolean;
};

type EnsureSandboxHealthOptions = {
  forceProvision?: boolean;
};

export default async function handler(options: WatchdogOptions = {}) {
  if (monitoringRoutesDisabled()) {
    log('watchdog.disabled', {});
    return new Response('watchdog routes disabled', { status: 200 });
  }

  const { forceProvision = false } = options;
  const startedAt = Date.now();
  const state = await loadState();

  log('watchdog.tick', { state, forceProvision });

  try {
    const nextState = await ensureSandboxHealth(state, { forceProvision });
    nextState.lastCheckAt = new Date().toISOString();
    nextState.lastFailure = null;
    await persistState(nextState);
    log('watchdog.tick.complete', { durationMs: Date.now() - startedAt });
  } catch (error) {
    const failure = {
      reason: error instanceof Error ? error.message : 'unknown-error',
      stack: error instanceof Error ? error.stack : undefined,
    };
    log('watchdog.tick.failed', failure, 'error');

    state.lastFailure = { reason: failure.reason, at: new Date().toISOString() };
    await persistState(state);

    return new Response('watchdog failure', { status: 500 });
  }

  return new Response('ok');
}

async function ensureSandboxHealth(state: SandboxState, options: EnsureSandboxHealthOptions = {}): Promise<SandboxState> {
  const { forceProvision = false } = options;
  let nextState = cloneState(state ?? DEFAULT_STATE);

  if (!nextState.draining) {
    nextState.draining = [];
  }

  const active = nextState.active;
  const now = Date.now();
  const rotationDue = !nextState.lastRotationAt
    ? false
    : now - new Date(nextState.lastRotationAt).getTime() >= ROTATION_INTERVAL_MS;

  const health: SandboxHealth = forceProvision
    ? { healthy: false, reason: 'force-provision-request' }
    : active
      ? await checkSandboxHealth(active, 'active')
      : { healthy: false, reason: 'no-active-sandbox' };

  if (health.healthy && active) {
    await pingKeepalive(active.url);
  }

  const shouldProvision = forceProvision || !health.healthy || rotationDue;

  if (shouldProvision) {
    const reason = forceProvision
      ? 'force-provision-request'
      : !health.healthy
        ? health.reason ?? 'health-check-failed'
        : 'rotation-due';
    log('sandbox.provision.start', { reason, previous: active?.id });

    const newSandbox = await provisionSandbox(reason);
    log('sandbox.provision.created', newSandbox);

    await waitForSandboxReadiness(newSandbox);
    log('sandbox.provision.ready', newSandbox);

    await promoteSandbox(newSandbox, active);

    nextState.active = { ...newSandbox, status: 'healthy' };
    nextState.lastRotationAt = new Date().toISOString();

    if (active) {
      nextState.draining.push({ ...active, drainStartedAt: new Date().toISOString() });
    }
  }

  if (nextState.draining.length > 0) {
    const survivors: DrainingSandboxRecord[] = [];
    for (const draining of nextState.draining) {
      const drainAge = now - new Date(draining.drainStartedAt).getTime();
      if (drainAge >= DRAIN_GRACE_MS) {
        await decommissionSandbox(draining, drainAge);
      } else {
        survivors.push(draining);
      }
    }
    nextState.draining = survivors;
  }

  return nextState;
}

async function checkSandboxHealth(sandbox: SandboxRecord, role: 'active' | 'candidate'): Promise<SandboxHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const url = `${sandbox.url}${HEALTH_ENDPOINT}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': 'sandbox-watchdog/1.0',
        'x-sandbox-bypass': 'true',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { healthy: false, reason: `health-status-${response.status}` };
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    log('sandbox.health.ok', { sandbox, role, payload });

    return { healthy: true, payload };
  } catch (error) {
    clearTimeout(timeout);
    const reason = error instanceof Error ? error.message : 'unknown-error';
    log('sandbox.health.error', { sandbox, role, reason }, 'warn');
    return { healthy: false, reason };
  }
}

async function pingKeepalive(baseUrl: string) {
  const url = `${baseUrl}${KEEPALIVE_ENDPOINT}`;
  try {
    await fetch(url, {
      headers: {
        'x-keepalive-token': SANDBOX_KEEPALIVE_TOKEN,
        'user-agent': 'sandbox-keepalive/1.0',
      },
    });
  } catch (error) {
    log('sandbox.keepalive.error', { url, error }, 'warn');
  }
}

async function provisionSandbox(reason: string): Promise<SandboxRecord> {
  const attempt = async (): Promise<SandboxRecord> => {
    log('sandbox.provision.create.start', { reason });
    const sandbox = await Sandbox.create({
      ports: [SANDBOX_START_PORT_NUMBER],
      runtime: 'node22',
      timeout: ROTATION_INTERVAL_MS,
      ...(SANDBOX_CREDENTIALS ?? {}),
    });

    const url = sandbox.domain(SANDBOX_START_PORT_NUMBER);
    const runtimeEnv: Record<string, string> = {
      PORT: SANDBOX_START_PORT,
      KEEPALIVE_TOKEN: SANDBOX_KEEPALIVE_TOKEN,
      SANDBOX_APP_REPO,
      SANDBOX_APP_REF,
      SANDBOX_SELF_URL: url,
    };
    const buildEnv: Record<string, string> = {
      NEXT_APP_SKIP_MONITORING_ROUTES: 'true',
    };
    runtimeEnv.NEXT_APP_SKIP_MONITORING_ROUTES = 'true';

    try {
      log('sandbox.bootstrap.env', {
        sandboxId: sandbox.sandboxId,
        repoUrl: SANDBOX_APP_REPO,
        gitRef: SANDBOX_APP_REF,
        workdir: SANDBOX_WORKDIR,
      });

      await runSandboxCommand(sandbox, 'prepare-workdir', {
        cmd: 'rm',
        args: ['-rf', SANDBOX_WORKDIR],
      });

      await runSandboxCommand(sandbox, 'create-workdir', {
        cmd: 'mkdir',
        args: ['-p', SANDBOX_WORKDIR],
      });

      await runSandboxCommand(sandbox, 'git-clone', {
        cmd: 'git',
        args: ['clone', '--branch', SANDBOX_APP_REF, '--single-branch', '--depth', '1', SANDBOX_APP_REPO, SANDBOX_WORKDIR],
      });

      await runSandboxCommand(sandbox, 'corepack-enable', {
        cmd: 'corepack',
        args: ['enable'],
        sudo: true,
      });

      await runSandboxCommand(sandbox, 'pnpm-install', {
        cmd: 'pnpm',
        args: ['install', '--no-frozen-lockfile'],
        cwd: SANDBOX_WORKDIR,
      });

      await runSandboxCommand(sandbox, 'pnpm-build', {
        cmd: 'pnpm',
        args: ['--filter', 'next-app', 'build'],
        cwd: SANDBOX_WORKDIR,
        env: buildEnv,
      });

      runtimeEnv.NODE_ENV = runtimeEnv.NODE_ENV ?? 'production';
      runtimeEnv.PORT = SANDBOX_START_PORT;

      await runSandboxCommand(sandbox, 'pnpm-start', {
        cmd: 'pnpm',
        args: ['--filter', 'next-app', 'start'],
        cwd: SANDBOX_WORKDIR,
        env: runtimeEnv,
        detached: true,
      });
    } catch (error) {
      const errorMessage = describeError(error);
      log('sandbox.bootstrap.error', { sandboxId: sandbox.sandboxId, error: errorMessage }, 'error');

      await sandbox.stop().catch(stopError => {
        log('sandbox.bootstrap.stop-error', { sandboxId: sandbox.sandboxId, error: describeError(stopError) }, 'warn');
      });

      throw error instanceof Error ? error : new Error(errorMessage);
    }

    log('sandbox.bootstrap.started', { sandboxId: sandbox.sandboxId, reason });

    return {
      id: sandbox.sandboxId,
      url,
      createdAt: new Date().toISOString(),
      status: 'provisioning',
    };
  };

  return pRetry(attempt, {
    retries: 4,
    factor: 2,
    minTimeout: 2_000,
    onFailedAttempt: error => {
      log('sandbox.provision.retry', { attemptNumber: error.attemptNumber, retriesLeft: error.retriesLeft, reason }, 'warn');
    },
  });
}

async function waitForSandboxReadiness(sandbox: SandboxRecord) {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes max

  while (Date.now() < deadline) {
    const health = await checkSandboxHealth(sandbox, 'candidate');
    if (health.healthy) {
      return;
    }
    await delay(5_000);
  }

  throw new Error(`sandbox ${sandbox.id} failed to become healthy in time`);
}

async function promoteSandbox(fresh: SandboxRecord, previous?: SandboxRecord) {
  const items: EdgeConfigOperation[] = [
    {
      operation: 'upsert',
      key: EDGE_CONFIG_KEYS.active,
      value: fresh.url,
    },
    {
      operation: 'upsert',
      key: EDGE_CONFIG_KEYS.lastKnownGood,
      value: fresh.url,
    },
  ];

  if (previous?.url) {
    items.push({
      operation: 'upsert',
      key: EDGE_CONFIG_KEYS.previous,
      value: previous.url,
    });
  }

  await updateEdgeConfig(items);
  log('sandbox.promote', { fresh, previous });
}

async function decommissionSandbox(sandbox: DrainingSandboxRecord, ageMs: number) {
  log('sandbox.decommission.start', { sandbox, ageMs });

  try {
    const instance = await Sandbox.get({
      sandboxId: sandbox.id,
      ...(SANDBOX_CREDENTIALS ?? {}),
    });

    await instance.stop();
    log('sandbox.decommission.success', { sandbox });
  } catch (error) {
    if (isSandboxNotFound(error)) {
      log('sandbox.decommission.not-found', { sandboxId: sandbox.id }, 'warn');
      return;
    }

    log('sandbox.decommission.error', { sandbox, error: describeError(error) }, 'error');
  }
}

async function loadState(): Promise<SandboxState> {
  const state = await get<SandboxState>(EDGE_CONFIG_KEYS.state);
  if (state) {
    return cloneState(state);
  }

  const legacyState = await get<SandboxState>(LEGACY_EDGE_CONFIG_KEYS.state);
  if (legacyState) {
    log('edge-config.legacy-key.detected', { key: LEGACY_EDGE_CONFIG_KEYS.state }, 'warn');
    return cloneState(legacyState);
  }

  return cloneState(DEFAULT_STATE);
}

async function persistState(state: SandboxState) {
  await updateEdgeConfig([
    {
      operation: 'upsert',
      key: EDGE_CONFIG_KEYS.state,
      value: state,
    },
  ]);
}

type SandboxCommandOptions = {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  detached?: boolean;
};

async function runSandboxCommand(sandbox: Sandbox, step: string, options: SandboxCommandOptions) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');

  const forwardChunk = (stream: 'stdout' | 'stderr') => (chunk: string) => {
    const lines = chunk.split(/\r?\n/).filter(line => line.trim().length > 0);
    for (const line of lines) {
      log(
        stream === 'stdout' ? 'sandbox.command.stdout' : 'sandbox.command.stderr',
        { sandboxId: sandbox.sandboxId, step, message: line },
        stream === 'stdout' ? 'info' : 'warn',
      );
    }
  };

  stdout.on('data', forwardChunk('stdout'));
  stderr.on('data', forwardChunk('stderr'));

  log('sandbox.command.start', {
    sandboxId: sandbox.sandboxId,
    step,
    cmd: options.cmd,
    args: options.args,
    cwd: options.cwd,
    detached: options.detached ?? false,
  });

  const result = await sandbox.runCommand({
    cmd: options.cmd,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    sudo: options.sudo,
    detached: options.detached,
    stdout,
    stderr,
  });

  if (options.detached) {
    // Detached commands keep running; exit code is not yet known.
    log('sandbox.command.detached', {
      sandboxId: sandbox.sandboxId,
      step,
      commandId: 'wait' in result ? result.cmdId : undefined,
    });
    return result;
  }

  const finished = result as { exitCode: number | null; signal?: string | null };
  const exitCode = finished.exitCode ?? null;

  log('sandbox.command.complete', {
    sandboxId: sandbox.sandboxId,
    step,
    exitCode,
    signal: 'signal' in finished ? finished.signal ?? null : null,
  });

  if (exitCode !== 0) {
    throw new Error(`Sandbox command "${step}" failed with exit code ${exitCode}`);
  }

  return result;
}

type EdgeConfigOperation =
  | {
      operation: 'upsert';
      key: string;
      value: unknown;
    }
  | {
      operation: 'delete';
      key: string;
    };

async function updateEdgeConfig(operations: EdgeConfigOperation[]) {
  const response = await fetch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${EDGE_CONFIG_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items: operations }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`edge-config-update-failed: ${response.status} ${error}`);
  }
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid SANDBOX_PORT value "${value}"`);
  }
  return parsed;
}

function getSandboxCredentials(): SandboxCredentials | undefined {
  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_API_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  return undefined;
}

function isSandboxNotFound(error: unknown): boolean {
  const response = typeof error === 'object' && error !== null && 'response' in error ? (error as { response?: { status?: number } }).response : undefined;
  return typeof response?.status === 'number' && response.status === 404;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

type LogPayload =
  | Record<string, unknown>
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | unknown[];

function log(event: string, payload: LogPayload = undefined, level: 'info' | 'warn' | 'error' = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] ${level.toUpperCase()} ${event}`;
  const suffix = formatLogPayload(payload);
  const message = suffix ? `${prefix} ${suffix}` : prefix;

  if (level === 'error') {
    console.error(message);
    return;
  }

  if (level === 'warn') {
    console.warn(message);
    return;
  }

  console.log(message);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    if (monitoringRoutesDisabled()) {
      log('watchdog.env.skip', { name });
      return '';
    }
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatLogPayload(payload: LogPayload): string {
  if (payload === undefined || payload === null) {
    return '';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }

  if (payload instanceof Error) {
    return JSON.stringify({ message: payload.message, stack: payload.stack });
  }

  if (Array.isArray(payload)) {
    return JSON.stringify(payload);
  }

  if (typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) {
      return '';
    }

    return entries
      .map(([key, value]) => `${key}=${formatLogValue(value)}`)
      .join(' ');
  }

  return String(payload);
}

function formatLogValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Error) {
    return JSON.stringify({ message: value.message, stack: value.stack });
  }

  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }

  return String(value);
}
