import { NextResponse } from 'next/server';

const startedAt = Date.now();

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const now = Date.now();
  const sandboxOrigin = request.headers.get('x-sandbox-origin') ?? process.env.SANDBOX_SELF_URL ?? null;

  return NextResponse.json({
    status: 'ok',
    service: 'next-app',
    sandboxOrigin,
    env: sandboxOrigin ? 'sandbox' : 'edge-router',
    uptimeSeconds: Math.round(process.uptime()),
    // coldStartMs: now - startedAt,
    timestamp: new Date(now).toISOString(),
  });
}
