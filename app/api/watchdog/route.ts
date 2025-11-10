import watchdogHandler from './watchdog';
import { monitoringRoutesDisabled } from '../_lib/monitoringToggle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function shouldForceProvision(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.has('force');
}

export async function GET(request: Request) {
  if (monitoringRoutesDisabled()) {
    return new Response(null, { status: 404 });
  }

  return watchdogHandler({ forceProvision: shouldForceProvision(request) });
}

export async function POST(request: Request) {
  if (monitoringRoutesDisabled()) {
    return new Response(null, { status: 404 });
  }

  return watchdogHandler({ forceProvision: shouldForceProvision(request) });
}

