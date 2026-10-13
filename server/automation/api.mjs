import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';

function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Separate loopback admin endpoint. Never pass this listener through ngrok. */
export async function startAutomationApi(manager, settings) {
  const token = String(settings.adminToken || '');
  const port = Number(settings.adminPort || 3002);
  if (token.length < 24) throw new Error('AI admin token must be at least 24 characters.');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(settings.mcpPort)) {
    throw new Error('AI admin port must be valid and different from the MCP port.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    // Browser origins (including localhost websites) must not call the admin API.
    if (req.headers.origin) return res.status(403).json({ error: 'Browser origins not allowed.' });
    if (!sameToken(req.get('authorization') || '', 'Bearer ' + token)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  const handler = fn => async (req, res) => {
    try {
      const payload = await fn(req);
      res.json(payload ?? { ok: true });
    } catch (error) {
      res.status(400).json({ error: String(error.message || error).slice(0, 500) });
    }
  };

  app.get('/api/status', handler(() => manager.status()));
  app.get('/api/instructions', handler(() => manager.getInstructions()));
  app.put('/api/instructions', handler(req => manager.setInstructions(req.body?.instructions)));
  app.get('/api/jobs', handler(() => manager.listJobs()));
  app.post('/api/jobs', handler(req => manager.upsertJob(req.body)));
  app.delete('/api/jobs/:id', handler(req => manager.deleteJob(req.params.id)));
  app.post('/api/jobs/:id/run', handler(async req => manager.runNow(req.params.id)));
  app.get('/api/history', handler(() => manager.listHistory()));

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port, stop: () => new Promise(resolve => server.close(resolve))
  };
}
