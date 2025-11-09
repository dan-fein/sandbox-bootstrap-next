#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import pino from 'pino';
const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
        component: 'sandbox-bootstrap',
    },
});
const DEFAULT_WORKDIR = '/tmp/next-sandbox-app';
const HEALTH_ENDPOINT = '/api/health';
async function main() {
    const repoUrl = env('SANDBOX_APP_REPO');
    const gitRef = process.env.SANDBOX_APP_REF ?? 'main';
    const workdir = process.env.SANDBOX_WORKDIR ?? DEFAULT_WORKDIR;
    const port = env('PORT');
    const sandboxUrl = env('SANDBOX_SELF_URL');
    const keepaliveToken = process.env.KEEPALIVE_TOKEN ?? '';
    logger.info({ repoUrl, gitRef, workdir, port, sandboxUrl }, 'sandbox bootstrap starting');
    await prepareWorkspace(workdir);
    await cloneRepository(repoUrl, gitRef, workdir);
    await installDependencies(workdir);
    await buildApplication(workdir);
    const starter = startServer(workdir, port, sandboxUrl);
    await waitForHealth(`${sandboxUrl}${HEALTH_ENDPOINT}`, keepaliveToken);
    logger.info({ sandboxUrl }, 'sandbox application is healthy');
    forwardSignals(starter);
}
function env(name) {
    const value = process.env[name];
    if (!value) {
        logger.error({ name }, 'missing required environment variable');
        process.exit(1);
    }
    return value;
}
async function prepareWorkspace(workdir) {
    if (!existsSync(workdir)) {
        logger.info({ workdir }, 'creating workspace directory');
        await mkdir(workdir, { recursive: true });
    }
}
async function cloneRepository(repoUrl, gitRef, workdir) {
    if (existsSync(join(workdir, '.git'))) {
        logger.info({ workdir }, 'repository already present, fetching latest changes');
        await execa('git', ['fetch', '--all'], { cwd: workdir, stdio: 'inherit' });
        await execa('git', ['checkout', gitRef], { cwd: workdir, stdio: 'inherit' });
        await execa('git', ['reset', '--hard', `origin/${gitRef}`], { cwd: workdir, stdio: 'inherit' });
        return;
    }
    logger.info({ repoUrl, gitRef, workdir }, 'cloning repository');
    await execa('git', ['clone', '--branch', gitRef, '--single-branch', repoUrl, workdir], {
        stdio: 'inherit',
    });
}
async function installDependencies(workdir) {
    logger.info({ workdir }, 'installing dependencies via pnpm');
    await execa('corepack', ['enable'], { stdio: 'inherit' });
    await execa('pnpm', ['install', '--frozen-lockfile'], { cwd: workdir, stdio: 'inherit' });
}
async function buildApplication(workdir) {
    logger.info('building Next.js application');
    await execa('pnpm', ['--filter', 'next-app', 'build'], { cwd: workdir, stdio: 'inherit' });
}
function startServer(workdir, port, sandboxUrl) {
    logger.info({ port }, 'starting Next.js server');
    const child = execa('pnpm', ['--filter', 'next-app', 'start', '--', '--port', port], {
        cwd: workdir,
        env: {
            ...process.env,
            PORT: port,
            SANDBOX_SELF_URL: sandboxUrl,
        },
        stdio: 'inherit',
    });
    child.catch(error => {
        logger.error({ error }, 'sandbox server crashed');
        process.exit(1);
    });
    return child;
}
async function waitForHealth(url, keepaliveToken) {
    logger.info({ url }, 'waiting for sandbox health endpoint');
    const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS ?? 90_000);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(url, {
                headers: keepaliveToken
                    ? {
                        'x-keepalive-token': keepaliveToken,
                    }
                    : undefined,
            });
            if (response.ok) {
                const payload = await response.json().catch(() => ({}));
                logger.info({ payload }, 'sandbox health check passed');
                return;
            }
            logger.warn({ status: response.status }, 'sandbox health endpoint not ready');
        }
        catch (error) {
            logger.warn({ message: error.message }, 'sandbox health probe failed');
        }
        await sleep(2_000);
    }
    logger.error({ url }, 'timed out waiting for sandbox health');
    process.exit(1);
}
function forwardSignals(child) {
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
        process.on(signal, () => {
            logger.info({ signal }, 'forwarding shutdown signal to Next.js server');
            const sent = child.kill(signal);
            if (!sent) {
                logger.warn({ signal }, 'failed to forward signal to sandbox server');
                return;
            }
            const timeout = setTimeout(() => {
                logger.warn({ signal }, 'force killing sandbox server after timeout');
                child.kill('SIGKILL');
            }, 30_000);
            if (typeof timeout.unref === 'function') {
                timeout.unref();
            }
        });
    }
}
void main();
//# sourceMappingURL=bootstrap.js.map