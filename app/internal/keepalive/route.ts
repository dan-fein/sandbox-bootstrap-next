import { NextResponse } from 'next/server';

const TOKEN_HEADER = 'x-keepalive-token';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = request.headers.get(TOKEN_HEADER);
  const expected = process.env.KEEPALIVE_TOKEN;

  if (!expected || token !== expected) {
    return NextResponse.json(
      { status: 'unauthorized', detail: 'Missing or invalid keepalive token' },
      { status: 401 }
    );
  }

  return NextResponse.json({
    status: 'ok',
    detail: 'sandbox keepalive acknowledged',
    timestamp: new Date().toISOString(),
  });
}
