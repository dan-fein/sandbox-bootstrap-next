import Link from 'next/link';
import { Suspense } from 'react';
import { headers } from 'next/headers';

const SANDBOX_HEADER = 'x-sandbox-origin';
const STREAM_DELAY_MS = 350;

type SandboxHealthPayload = {
  status?: string;
  env?: string;
  uptimeSeconds?: number;
  timestamp?: string;
  sandboxOrigin?: string | null;
  watchdogLastCheckAt?: string | null;
  watchdogLastRotationAt?: string | null;
};

type HeaderStore = Awaited<ReturnType<typeof headers>>;

async function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function LoadingSandboxInfo(): JSX.Element {
  return (
    <div className="live-panel pending">
      <span className="label">Active sandbox</span>
      <span className="value shimmer">Detecting…</span>
      <dl className="telemetry">
        <div>
          <dt>Status</dt>
          <dd className="shimmer">Loading…</dd>
        </div>
        <div>
          <dt>Environment</dt>
          <dd className="shimmer">Loading…</dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd className="shimmer">Loading…</dd>
        </div>
        <div>
          <dt>Last Check</dt>
          <dd className="shimmer">Loading…</dd>
        </div>
      </dl>
      <p>Streaming sandbox telemetry…</p>
    </div>
  );
}

async function SandboxInfo(): Promise<JSX.Element> {
  await wait(STREAM_DELAY_MS);
  const requestHeaders = await headers();
  const sandboxOrigin = requestHeaders.get(SANDBOX_HEADER);
  const telemetry = await readSandboxTelemetry(requestHeaders, sandboxOrigin);

  const status = telemetry?.status ?? 'unknown';
  const environment = telemetry?.env ?? (sandboxOrigin ? 'sandbox' : 'router');
  const uptime = formatDuration(telemetry?.uptimeSeconds);
  const lastChecked = formatTimestamp(telemetry?.watchdogLastCheckAt ?? telemetry?.timestamp);
  const hasTelemetry = Boolean(telemetry);

  return (
    <div className="live-panel">
      <span className="label">Active sandbox</span>
      <span className="value">{sandboxOrigin ?? 'No sandbox detected'}</span>
      <dl className="telemetry">
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
        {/* <div>
          <dt>Environment</dt>
          <dd>{environment}</dd>
        </div> */}
        <div>
          <dt>Uptime</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>Last Check</dt>
          <dd>{lastChecked}</dd>
        </div>
      </dl>
      <p>
        Requests are annotated with the <code>{SANDBOX_HEADER}</code> header so the router can steer
        traffic toward the healthiest sandbox.
      </p>
      {!hasTelemetry ? <p className="muted">Telemetry is warming up. Check back in a moment.</p> : null}
    </div>
  );
}

function formatDuration(totalSeconds?: number): string {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '—';
  }

  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  const segments = [];
  if (hours) {
    segments.push(`${hours}h`);
  }
  if (minutes || hours) {
    segments.push(`${minutes}m`);
  }
  segments.push(`${remainingSeconds}s`);

  return segments.join(' ');
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) {
    return '—';
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

async function readSandboxTelemetry(
  requestHeaders: HeaderStore,
  sandboxOrigin: string | null,
): Promise<SandboxHealthPayload | null> {
  if (sandboxOrigin) {
    const telemetry = await fetchHealth(new URL('/api/health', sandboxOrigin).toString(), true);
    if (telemetry) {
      return telemetry;
    }
  }

  const fallbackUrl = buildLocalUrl(requestHeaders, '/api/health');
  if (fallbackUrl) {
    const telemetry = await fetchHealth(fallbackUrl);
    if (telemetry) {
      return telemetry;
    }
  }

  return null;
}

async function fetchHealth(url: string, bypassSandbox = false): Promise<SandboxHealthPayload | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: bypassSandbox
        ? {
            'x-sandbox-bypass': 'true',
          }
        : undefined,
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as SandboxHealthPayload;
  } catch {
    return null;
  }
}

function buildLocalUrl(requestHeaders: HeaderStore, path: string): string | null {
  const host = requestHeaders.get('host');
  if (!host) {
    return null;
  }

  const forwardedProto = requestHeaders.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0]?.trim() || (host.includes('localhost') ? 'http' : 'https');
  return `${protocol}://${host}${path}`;
}

export function HomePageContent(): JSX.Element {
  return (
    <main className="home">
      <section className="hero">
        <span className="eyebrow">Vercel Sandbox Router</span>
        <h1>Zero-downtime sandboxes, one entry point.</h1>
        <p>
          Some might argue that this is a waste of resources. It might be.
          </p>
        {/* <div className="cta-row">
          <Link href="/api/health" className="button primary">
            Check health
          </Link>
          
        </div> */}
      </section>

      <section className="info-grid">
        <article className="info-card">
          <h2>Live telemetry</h2>
          <Suspense fallback={<LoadingSandboxInfo />}>
            <SandboxInfo />
          </Suspense>
        </article>

        <article className="info-card">
          <h2>How it works</h2>
          <ul className="feature-list">
            <li>A scheduled watchdog checks sandbox health about every five minutes and provisions a fresh one when needed.</li>
            <li>Middleware reads Edge Config to rewrite traffic to the current sandbox and tags requests with <code>x-sandbox-origin</code>.</li>
          </ul>
        </article>
      </section>

      <footer className="footnote">
        Built for teams who need dependable preview environments without juggling hostnames.
      </footer>
    </main>
  );
}

export default function HomePage(): JSX.Element {
  return <HomePageContent />;
}
