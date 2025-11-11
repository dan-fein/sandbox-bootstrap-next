import { NextResponse, type NextRequest } from 'next/server';
import { get } from '@vercel/edge-config';

const EDGE_CONFIG_KEYS = {
  active: 'sandbox_active_url',
  lastKnownGood: 'sandbox_last_known_good_url',
} as const;

const LEGACY_EDGE_CONFIG_KEYS = {
  active: 'sandbox.activeUrl',
  lastKnownGood: 'sandbox.lastKnownGoodUrl',
} as const;

const SANDBOX_BYPASS_HEADER = 'x-sandbox-bypass';
const ROUTE_BYPASS_PREFIXES = ['/api', '/watchdog', '/favicon.ico', '/robots.txt', '/sitemap', '/bootstrap.js', '/bootstrap.js.map'];
const DEBUG_SANDBOX_ROUTING = process.env.DEBUG_SANDBOX_ROUTING === 'true';
const LOCAL_HOME_PREFIX = '/local-home';

function shouldBypassMiddleware(request: NextRequest): boolean {
  if (isSelfRequest(request) || process.env.DISABLE_EDGE_REWRITE === 'true') {
    return true;
  }

  if (request.headers.get(SANDBOX_BYPASS_HEADER) === 'true') {
    return true;
  }

  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/_next')) {
    const referer = request.headers.get('referer') ?? '';
    if (referer.includes(LOCAL_HOME_PREFIX)) {
      return true;
    }
  }

  return ROUTE_BYPASS_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function isSelfRequest(request: NextRequest): boolean {
  const selfUrl = process.env.SANDBOX_SELF_URL;
  if (!selfUrl) {
    return false;
  }

  const selfHost = safeHostFromUrl(selfUrl);
  if (!selfHost) {
    return true;
  }

  const requestHost = (request.headers.get('host') ?? request.nextUrl.host ?? '').toLowerCase();
  if (!requestHost) {
    return false;
  }

  return requestHost === selfHost;
}

function safeHostFromUrl(urlString: string): string | null {
  try {
    return new URL(urlString).host.toLowerCase();
  } catch {
    console.warn('middleware.invalid-self-url', { urlString });
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith(LOCAL_HOME_PREFIX)) {
    return await handleLocalHome(request);
  }

  if (shouldBypassMiddleware(request)) {
    return NextResponse.next();
  }

  try {
    const activeUrl = await readEdgeConfigUrl([EDGE_CONFIG_KEYS.active, LEGACY_EDGE_CONFIG_KEYS.active]);
    if (activeUrl) {
      return await rewriteToSandbox('active', activeUrl, request);
    }

    const fallbackUrl = await readEdgeConfigUrl([EDGE_CONFIG_KEYS.lastKnownGood, LEGACY_EDGE_CONFIG_KEYS.lastKnownGood]);
    if (fallbackUrl) {
      return await rewriteToSandbox('fallback', fallbackUrl, request);
    }
  } catch (error) {
    console.error('middleware.edge-routing.error', {
      message: error instanceof Error ? error.message : 'unknown-error',
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  return new NextResponse('No healthy sandbox available', {
    status: 503,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

async function handleLocalHome(request: NextRequest): Promise<NextResponse> {
  try {
    const sandboxOrigin = await resolveSandboxOrigin();
    if (!sandboxOrigin) {
      return NextResponse.next();
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-sandbox-origin', sandboxOrigin);

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set('x-sandbox-origin', sandboxOrigin);
    response.headers.set('x-sandbox-routing', 'local-view');
    return response;
  } catch (error) {
    console.error('middleware.local-home.error', {
      message: error instanceof Error ? error.message : 'unknown-error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.next();
  }
}

async function rewriteToSandbox(kind: 'active' | 'fallback', targetUrl: string, request: NextRequest): Promise<NextResponse> {
  const rewriteUrl = composeSandboxUrl(targetUrl, request);
  const debug = await probeSandbox(rewriteUrl, request);
  const sandboxOrigin = extractOrigin(targetUrl);
  const requestHeaders = new Headers(request.headers);
  if (sandboxOrigin) {
    requestHeaders.set('x-sandbox-origin', sandboxOrigin);
  }
  const response = NextResponse.rewrite(rewriteUrl, {
    request: { headers: requestHeaders },
  });
  if (sandboxOrigin) {
    response.headers.set('x-sandbox-origin', sandboxOrigin);
  }
  response.headers.set('x-sandbox-routing', kind === 'active' ? 'edge-rewrite' : 'edge-rewrite-stale');
  if (debug) {
    response.headers.set('x-sandbox-probe-status', String(debug.status));
    if (debug.error) {
      response.headers.set('x-sandbox-probe-error', debug.error);
    }
  }
  logSandboxRouting(kind, request, rewriteUrl, debug);
  return response;
}

function composeSandboxUrl(baseUrl: string, request: NextRequest): string {
  const target = new URL(baseUrl);
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  return target.toString();
}

async function readEdgeConfigUrl(keys: readonly string[]): Promise<string | null> {
  for (const key of keys) {
    const value = await get<string | null>(key);
    if (value) {
      return value;
    }
  }
  return null;
}

export const config = {
  matcher: ['/((?!favicon.ico).*)'],
};

type SandboxProbeResult = { status: number; error?: string };

async function probeSandbox(rewriteUrl: string, request: NextRequest): Promise<SandboxProbeResult | null> {
  if (!DEBUG_SANDBOX_ROUTING) {
    return null;
  }

  try {
    const probeUrl = new URL(rewriteUrl);
    const method = request.method.toUpperCase();
    const probeMethod = method === 'GET' || method === 'HEAD' ? 'HEAD' : 'OPTIONS';
    const probe = await fetch(probeUrl.toString(), {
      method: probeMethod,
      headers: {
        'user-agent': 'sandbox-router-debug/1.0',
      },
      cache: 'no-store',
    });
    return { status: probe.status };
  } catch (error) {
    return {
      status: -1,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function logSandboxRouting(kind: 'active' | 'fallback', request: NextRequest, rewriteUrl: string, debug: SandboxProbeResult | null) {
  if (!DEBUG_SANDBOX_ROUTING) {
    return;
  }

  const payload: Record<string, unknown> = {
    event: 'middleware.sandbox-routing',
    kind,
    method: request.method,
    path: request.nextUrl.pathname,
    rewriteUrl,
    probeStatus: debug?.status ?? null,
  };

  if (debug?.error) {
    payload.probeError = debug.error;
  }

  console.log(JSON.stringify(payload));
}

async function resolveSandboxOrigin(): Promise<string | null> {
  const activeUrl = await readEdgeConfigUrl([EDGE_CONFIG_KEYS.active, LEGACY_EDGE_CONFIG_KEYS.active]);
  if (activeUrl) {
    return extractOrigin(activeUrl);
  }

  const fallbackUrl = await readEdgeConfigUrl([EDGE_CONFIG_KEYS.lastKnownGood, LEGACY_EDGE_CONFIG_KEYS.lastKnownGood]);
  if (fallbackUrl) {
    return extractOrigin(fallbackUrl);
  }

  return null;
}

function extractOrigin(urlString: string): string | null {
  try {
    return new URL(urlString).origin;
  } catch (error) {
    console.warn('middleware.invalid-sandbox-url', {
      urlString,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
