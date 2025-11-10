import watchdogHandler from './watchdog';
import { monitoringRoutesDisabled } from '../_lib/monitoringToggle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  if (monitoringRoutesDisabled()) {
    return new Response(null, { status: 404 });
  }

  return watchdogHandler();
}

export async function POST() {
  if (monitoringRoutesDisabled()) {
    return new Response(null, { status: 404 });
  }

  return watchdogHandler();
}

