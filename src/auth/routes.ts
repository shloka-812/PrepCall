/**
 * Auth routes — OAuth callback handler.
 */
import { Router, Request, Response } from 'express';
import { exchangeCodeForTokens, verifyState } from './oauth.js';
import { isUserAuthed } from './store.js';

type OnAuthComplete = (phoneNumber: string) => Promise<void> | void;

const SUCCESS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connected — Granola Agent</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@500;600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #0a0a0b;
      color: #f0f0f0;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow: hidden;
    }
    .card {
      text-align: center;
      max-width: 420px;
      animation: fadeUp 0.6s cubic-bezier(0.32, 0.72, 0, 1) forwards;
      opacity: 0;
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .logos {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin-bottom: 40px;
      animation-delay: 0.1s;
    }
    .logo-circle {
      width: 48px; height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 700;
      font-family: 'Urbanist', sans-serif;
    }
    .linq-logo { background: #f0f0f0; color: #0a0a0b; }
    .granola-logo { background: #f0f0f0; color: #0a0a0b; font-size: 20px; }
    .x-mark { color: #8a8a8e; font-size: 14px; font-weight: 500; }
    .check {
      width: 64px; height: 64px;
      border-radius: 50%;
      background: #f0f0f0;
      color: #0a0a0b;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 28px;
      animation: scaleIn 0.5s cubic-bezier(0.32, 0.72, 0, 1) 0.3s forwards;
      opacity: 0;
      transform: scale(0.5);
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.5); }
      to { opacity: 1; transform: scale(1); }
    }
    h1 {
      font-family: 'Urbanist', sans-serif;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
    }
    p {
      font-size: 15px;
      color: #8a8a8e;
      line-height: 1.6;
      margin-bottom: 8px;
    }
    .cta {
      margin-top: 32px;
      display: inline-block;
      background: #f0f0f0;
      color: #0a0a0b;
      font-size: 14px;
      font-weight: 600;
      padding: 12px 28px;
      border-radius: 10px;
      text-decoration: none;
      transition: opacity 0.2s;
    }
    .cta:hover { opacity: 0.8; }
    .footer {
      margin-top: 48px;
      font-size: 12px;
      color: #8a8a8e;
      opacity: 0.5;
    }
    /* Confetti */
    .confetti-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; }
    .confetti {
      position: absolute;
      top: -10px;
      width: 8px; height: 8px;
      border-radius: 2px;
      animation: fall linear forwards;
    }
    @keyframes fall {
      to { transform: translateY(105vh) rotate(720deg); opacity: 0; }
    }
  </style>
</head>
<body>
  <div class="confetti-container" id="confetti"></div>
  <div class="card">
    <div class="logos">
      <div class="logo-circle linq-logo">L</div>
      <span class="x-mark">&times;</span>
      <div class="logo-circle granola-logo">G</div>
    </div>
    <div class="check">&#10003;</div>
    <h1>Connected</h1>
    <p>Your Granola account is linked to your Linq agent.</p>
    <p>Head back to iMessage — just text any question about your meetings.</p>
    <a href="sms:+16504447005" class="cta">Open iMessage</a>
    <div class="footer">Powered by Linq Blue &times; Granola MCP</div>
  </div>
  <script>
    const colors = ['#f0f0f0','#8a8a8e','#ff5722','#ffffff','#cccccc'];
    const container = document.getElementById('confetti');
    for (let i = 0; i < 60; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + '%';
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.animationDuration = (2 + Math.random() * 3) + 's';
      el.style.animationDelay = (Math.random() * 1.5) + 's';
      el.style.width = (6 + Math.random() * 6) + 'px';
      el.style.height = (6 + Math.random() * 6) + 'px';
      el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      container.appendChild(el);
    }
  </script>
</body>
</html>`;

const ERROR_PAGE = (errorMsg: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auth Failed — Granola Agent</title>
  <link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #0a0a0b; color: #f0f0f0;
      min-height: 100dvh;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .card { text-align: center; max-width: 420px; }
    h1 { font-family: 'Urbanist', sans-serif; font-size: 28px; font-weight: 700; margin-bottom: 12px; }
    p { font-size: 15px; color: #8a8a8e; line-height: 1.6; margin-bottom: 8px; }
    .error { color: #ff5722; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Auth Failed</h1>
    <p>Something went wrong connecting your Granola account.</p>
    <p>Go back to iMessage and text the agent to try again.</p>
    <p class="error">${errorMsg}</p>
  </div>
</body>
</html>`;

export function createAuthRoutes(getBaseUrl: () => string, onAuthComplete?: OnAuthComplete): Router {
  const router = Router();

  // Rate limit: max 10 callback attempts per IP per 5 minutes
  const callbackAttempts = new Map<string, { count: number; resetAt: number }>();

  router.get('/auth/callback', async (req: Request, res: Response) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; frame-ancestors 'none'");

    // Rate limiting
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || 'unknown');
    const now = Date.now();
    const limit = callbackAttempts.get(clientIp);
    if (limit && now < limit.resetAt) {
      limit.count++;
      if (limit.count > 10) {
        console.warn(`[auth] Rate limited: ${clientIp}`);
        res.status(429).send(ERROR_PAGE('Too many attempts. Try again in a few minutes.'));
        return;
      }
    } else {
      callbackAttempts.set(clientIp, { count: 1, resetAt: now + 5 * 60 * 1000 });
    }

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const error = String(req.query.error || '');

    if (error) {
      console.error(`[auth] OAuth error: ${error}`);
      res.status(400).send(ERROR_PAGE(error));
      return;
    }

    if (!code || !state) {
      res.status(400).send(ERROR_PAGE('Missing authorization code'));
      return;
    }

    // Verify signed state token — prevents someone from forging the phone number
    const phoneNumber = verifyState(state);
    if (!phoneNumber) {
      console.error(`[auth] Invalid state token — possible tampering`);
      res.status(400).send(ERROR_PAGE('Invalid authorization state'));
      return;
    }
    console.log(`[auth] Callback received for ${phoneNumber}`);

    const result = await exchangeCodeForTokens(code, phoneNumber, getBaseUrl());

    if (result.success) {
      console.log(`[auth] User ${phoneNumber} authenticated successfully!`);

      // Send welcome message via iMessage (non-blocking)
      if (onAuthComplete) {
        Promise.resolve(onAuthComplete(phoneNumber)).catch(() => {});
      }

      res.status(200).send(SUCCESS_PAGE);
    } else {
      console.error(`[auth] Auth failed for ${phoneNumber}: ${result.error}`);
      res.status(400).send(ERROR_PAGE(result.error || 'Unknown error'));
    }
  });

  router.get('/auth/status/:phone', (req: Request, res: Response) => {
    const phone = String(req.params.phone);
    res.json({ phone, authed: isUserAuthed(phone) });
  });

  return router;
}
