import { NextResponse } from 'next/server';
import { get } from '@vercel/edge-config';
import { monitoringRoutesDisabled } from '../_lib/monitoringToggle';

const startedAt = Date.now();

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (monitoringRoutesDisabled()) {
    return new Response(null, { status: 404 });
  }

  const now = Date.now();
  const sandboxOrigin = request.headers.get('x-sandbox-origin') ?? process.env.SANDBOX_SELF_URL ?? null;
  const watchdogState = await readWatchdogState();

  return NextResponse.json({
    status: 'ok',
    service: 'next-app',
    sandboxOrigin,
    env: sandboxOrigin ? 'sandbox' : 'router',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date(now).toISOString(),
    watchdogLastCheckAt: watchdogState?.lastCheckAt ?? null,
    watchdogLastRotationAt: watchdogState?.lastRotationAt ?? null,
  });
}

const EDGE_CONFIG_STATE_KEYS = ['sandbox_state', 'sandbox.state'] as const;

type WatchdogState = {
  lastCheckAt?: string | null;
  lastRotationAt?: string | null;
};

async function readWatchdogState(): Promise<WatchdogState | null> {
  for (const key of EDGE_CONFIG_STATE_KEYS) {
    try {
      const state = await get<WatchdogState | null>(key);
      if (state) {
        return state;
      }
    } catch (error) {
      console.warn('health.edge-config.read-error', {
        key,
        message: error instanceof Error ? error.message : 'unknown-error',
      });
      break;
    }
  }

  return null;
}
