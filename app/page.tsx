import Link from 'next/link';
import { headers } from 'next/headers';

const SANDBOX_HEADER = 'x-sandbox-origin';

export default async function HomePage() {
  const requestHeaders = await headers();
  const sandboxOrigin = requestHeaders.get(SANDBOX_HEADER) ?? 'unknown';

  return (
    <main>
      <section className="card">
        <h1>Vercel Sandbox Router</h1>
        <p>
          Traffic hitting this Nex   t.js application is routed through a logical control-plane that
          resolves the currently healthy Vercel Sandbox and forwards requests via Middleware rewrites.
        </p>
        <p>
          Active sandbox origin: <code>{sandboxOrigin}</code>
        </p>
      </section>
      <section className="card">
        <h2>Operational Endpoints</h2>
        <ul>
          <li>
            <Link href="/health">Health Check</Link>
          </li>
          <li>
            <Link href="/internal/keepalive" prefetch={false}>
              Private Keepalive
            </Link>
          </li>
        </ul>
      </section>
      <footer>
        Requests are rewritten at the edge, instrumented, and fanned into the active sandbox while cold
        pools are drained gracefully every five hours.
      </footer>
    </main>
  );
}
