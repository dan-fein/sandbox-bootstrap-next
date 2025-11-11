import { NextResponse } from 'next/server';
import { monitoringRoutesDisabled } from '../_lib/monitoringToggle';

const startedAt = Date.now();

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (monitoringRoutesDisabled()) {
    return new Response(null, { status: 404 });
  }

  const now = Date.now();
  const sandboxOrigin = request.headers.get('x-sandbox-origin') ?? process.env.SANDBOX_SELF_URL ?? null;

  return NextResponse.json({
    status: 'ok',
    service: 'next-app',
    sandboxOrigin,
    env: sandboxOrigin ? 'sandbox' : 'router',
    uptimeSeconds: Math.round(process.uptime()),
    // coldStartMs: now - startedAt,
    timestamp: new Date(now).toISOString(),
  });
}
