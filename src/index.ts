import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createWebhookHandler } from './webhook/handler.js';
import { createWebhookMessageHandler, createReactionHandler } from './webhook/router.js';

const app = express();
const PORT = process.env.PORT || 3000;

// The public base URL (set by ngrok in local dev)
let publicBaseUrl = process.env.BASE_URL || '';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook endpoint for Linq Blue
app.post(
  '/webhook',
  createWebhookHandler(createWebhookMessageHandler(), createReactionHandler())
);

// Auto-detect ngrok URL for local dev
async function detectNgrokUrl(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('http://localhost:4040/api/tunnels', { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json() as { tunnels: Array<{ public_url: string }> };
    const tunnel = data.tunnels.find(t => t.public_url.startsWith('https://'));
    return tunnel?.public_url || null;
  } catch {
    return null;
  }
}

async function main() {
  // #region agent log
  fetch('http://127.0.0.1:7342/ingest/eb9bc1c4-d0e8-44f8-bb63-a46dc8b354bd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7b9346' }, body: JSON.stringify({ sessionId: '7b9346', runId: 'pre-fix', hypothesisId: 'H4', location: 'src/index.ts:main:startup', message: 'Starting server', data: { pid: process.pid, node: process.version, argv: process.argv.slice(0, 5), envPort: process.env.PORT || null, resolvedPort: PORT, baseUrlEnv: process.env.BASE_URL || null, nodeEnv: process.env.NODE_ENV || null }, timestamp: Date.now() }) }).catch(() => { });
  // #endregion agent log

  // Detect public URL
  if (!publicBaseUrl) {
    detectNgrokUrl().then(url => {
      if (url) {
        publicBaseUrl = url;
        console.log(`[main] Detected ngrok URL:  ${publicBaseUrl}`);
      }
    }).catch(() => { });
    publicBaseUrl = `http://localhost:${PORT}`;
  }

  const server = app.listen(PORT, () => {
    // #region agent log
    fetch('http://127.0.0.1:7342/ingest/eb9bc1c4-d0e8-44f8-bb63-a46dc8b354bd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7b9346' }, body: JSON.stringify({ sessionId: '7b9346', runId: 'pre-fix', hypothesisId: 'H1', location: 'src/index.ts:main:listenCallback', message: 'Listening', data: { pid: process.pid, port: PORT, publicBaseUrl }, timestamp: Date.now() }) }).catch(() => { });
    // #endregion agent log

    console.log(`
╔═══════════════════════════════════════════════════════╗
║              PrepCall (Linq Blue)                     ║
╠═══════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                     ║
║  Public: ${publicBaseUrl.padEnd(42)}                  ║
╚═══════════════════════════════════════════════════════╝
    `);
  });

  server.on('error', (err: unknown) => {
    const e = err as { code?: string; message?: string; syscall?: string; address?: string; port?: number };
    // #region agent log
    fetch('http://127.0.0.1:7342/ingest/eb9bc1c4-d0e8-44f8-bb63-a46dc8b354bd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7b9346' }, body: JSON.stringify({ sessionId: '7b9346', runId: 'pre-fix', hypothesisId: 'H2', location: 'src/index.ts:main:serverError', message: 'Server listen error', data: { pid: process.pid, port: PORT, code: e.code || null, syscall: e.syscall || null, address: e.address || null, errorMessage: e.message || null }, timestamp: Date.now() }) }).catch(() => { });
    // #endregion agent log
  });
}

main().catch(console.error);
