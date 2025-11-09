import { context, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('next-app');

export async function register() {
  if (typeof window !== 'undefined') {
    return;
  }

  tracer.startActiveSpan('startup', span => {
    span.setAttribute('app.name', 'next-app');
    span.setAttribute('app.runtime', 'next.js');
    span.setAttribute('sandbox.routing-layer', 'middleware-edge-config');
    span.end();
  });

  const rootContext = context.active();
  tracer.startActiveSpan('keepalive-config', {}, rootContext, span => {
    span.setAttribute('keepalive.enabled', Boolean(process.env.KEEPALIVE_TOKEN));
    span.end();
  });
}
