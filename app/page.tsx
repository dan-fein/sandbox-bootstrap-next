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
      <p className="shimmer">Preparing sandbox details…</p>
      <p className="muted shimmer">Telemetry is warming up.</p>
    </div>
  );
}

async function SandboxInfo(): Promise<JSX.Element> {
  await wait(STREAM_DELAY_MS);
  const requestHeaders = await headers();
  const sandboxOrigin = requestHeaders.get(SANDBOX_HEADER);
  const telemetry = await readSandboxTelemetry(requestHeaders, sandboxOrigin);

  const hasTelemetry = Boolean(telemetry);
  const activeSandbox = telemetry?.sandboxOrigin ?? sandboxOrigin ?? 'No sandbox detected';
  const telemetryStatusMessage = hasTelemetry
    ? 'Telemetry streaming from the active sandbox.'
    : 'Telemetry is warming up. Check back in a moment.';

  return (
    <div className="live-panel">
      <span className="label">Active sandbox</span>
      <span className="value">{activeSandbox}</span>
      <p>
        Requests are annotated with the <code>{SANDBOX_HEADER}</code> header so the router can steer
        traffic toward the healthiest sandbox.
      </p>
      <p className="muted">{telemetryStatusMessage}</p>
    </div>
  );
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
