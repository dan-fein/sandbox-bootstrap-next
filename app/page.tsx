import Link from 'next/link';
import { headers } from 'next/headers';

const SANDBOX_HEADER = 'x-sandbox-origin';

export default async function HomePage() {
  const requestHeaders = await headers();
  const sandboxOrigin = requestHeaders.get(SANDBOX_HEADER) ?? 'unknown';
  console.log('sandboxOrigin', sandboxOrigin);

  return (
    <main>
      <section className="card">
        <h1>Vercel Sandbox Router</h1>
        <p>
          This app automatically forwards every request to the sandbox that is currently healthy, so
          you always land in the right environment.
        </p>
        <p>
         There is nothing efficient about this setup.
        </p>
        <p>
          Some might argue that this is a waste of resources. It might be.
        </p>
        <p>
          Active sandbox origin: <code>{sandboxOrigin}</code>
        </p>
      </section>
      <section className="card">
        <h2>Quick Checks</h2>
        <ul>
          <li>
            <Link href="/api/health">Health status</Link>
          </li>
          <li>
            <Link href="/internal/keepalive" prefetch={false}>
              Keepalive ping (auth required)
            </Link>
          </li>
        </ul>
      </section>
      <footer>
        The router rewrites requests at the edge, keeps an eye on each sandbox, and rotates to a fresh
        instance roughly every five hours.
      </footer>
    </main>
  );
}
