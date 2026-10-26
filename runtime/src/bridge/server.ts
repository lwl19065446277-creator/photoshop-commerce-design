import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { resultSchema, helloSchema } from '../contracts.js';
import { StudioError, errorData } from '../errors.js';
import type { PhotoshopService } from './service.js';

function send(res: ServerResponse, status: number, data?: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}
async function json(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new StudioError('CONTENT_TYPE', 'Expected application/json');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new StudioError('BODY_TOO_LARGE', 'Request exceeds 4 MiB');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StudioError('INVALID_JSON', 'Invalid JSON request body'); }
}
export function bridgeServer(service: PhotoshopService, getToken: () => string) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { service: 'Design Agent Studio', protocolVersion: 1 });
      // No CORS. UXP/CLI authenticate explicitly; ordinary browser origins cannot drive this endpoint.
      if (req.headers.origin && /^https?:/i.test(req.headers.origin)) throw new StudioError('ORIGIN_DENIED', 'Browser origins are not permitted');
      const expected = Buffer.from(`Bearer ${getToken()}`);
      const received = Buffer.from(req.headers.authorization || '');
      if (received.length !== expected.length || !timingSafeEqual(expected, received)) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid bridge token' } });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, service.status());
      if (req.method === 'POST' && url.pathname === '/api/commands') {
        const body = z.object({ operation: z.string(), args: z.record(z.unknown()) }).strict().parse(await json(req));
        return send(res, 200, { result: await service.execute(body.operation, body.args) });
      }
      if (req.method === 'POST' && url.pathname === '/plugin/hello') {
        const body = helloSchema.parse(await json(req));
        const session = service.queue.hello(body);
        service.clearManagedDocuments();
        await service.journal.record({ event: 'plugin_connected', ...body, ...session });
        return send(res, 200, session);
      }
      if (req.method === 'GET' && url.pathname === '/plugin/next') {
        const command = await service.queue.next(url.searchParams.get('sessionId') || '');
        if (res.destroyed) return;
        return send(res, command ? 200 : 204, command ? { command } : undefined);
      }
      if (req.method === 'POST' && url.pathname === '/plugin/disconnect') {
        const body = z.object({ sessionId: z.string() }).strict().parse(await json(req));
        service.queue.disconnect(body.sessionId);
        service.clearManagedDocuments();
        await service.journal.record({ event: 'plugin_disconnected', sessionId: body.sessionId });
        return send(res, 200, { disconnected: true });
      }
      if (req.method === 'POST' && url.pathname === '/plugin/result') {
        const body = resultSchema.parse(await json(req));
        // Persist receipt before resolving the caller's execution promise.
        service.queue.touch(body.sessionId);
        await service.journal.record({ event: 'plugin_result', ...body });
        service.queue.finish(body);
        return send(res, 200, { accepted: true });
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
    } catch (error) {
      const details = error instanceof ZodError ? { code: 'INVALID_ARGUMENTS', message: 'Schema validation failed', details: error.issues } : errorData(error);
      if (!res.headersSent) send(res, details.code === 'INTERNAL_ERROR' ? 500 : 400, { error: details });
    }
  });
}
