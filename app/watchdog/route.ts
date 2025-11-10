import watchdogHandler from './watchdog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return watchdogHandler();
}

export async function POST() {
  return watchdogHandler();
}



