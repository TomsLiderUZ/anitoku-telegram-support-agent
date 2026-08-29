'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { createLogger } = require('../core/logger');
const { settings } = require('../core/db');
const auth = require('./auth');
const apiRouter = require('./routes/api');
const tg = require('../telegram/client');
const keyPool = require('../ai/keyPool');
const runtime = require('../agent/runtime');

const log = createLogger('admin');

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  if (config.admin.trustProxy) app.set('trust proxy', 1);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Baseline hardening. The panel is same-origin and self-contained, so a
  // strict CSP costs nothing and blocks injected content outright.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'"
    );
    next();
  });

  app.use(auth.csrfGuard);

  // ── public endpoints ──────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    const health = keyPool.health();
    const providersUp = Object.values(PROVIDER_KEYS(health)).some((v) => v > 0);
    const ok = tg.isConnected() && providersUp;
    res.status(ok ? 200 : 503).json({
      ok,
      telegram: tg.status,
      keysAvailable: PROVIDER_KEYS(health),
      agent: { paused: settings.bool('agent_paused', false), replies24h: runtime.snapshot().replies24h },
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get('/login', (req, res) => {
    const cookies = auth.parseCookies(req.headers.cookie);
    if (auth.readSession(cookies[auth.COOKIE])) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const out = auth.login(username, password, req);
    if (!out.ok) return res.status(401).json({ error: out.error });
    res.cookie(auth.COOKIE, out.session.sid, auth.cookieOptions());
    res.json({ ok: true, admin: out.admin });
  });

  app.post('/logout', (req, res) => {
    const cookies = auth.parseCookies(req.headers.cookie);
    if (cookies[auth.COOKIE]) auth.logout(cookies[auth.COOKIE]);
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ── protected ─────────────────────────────────────────────────────────────
  app.use('/api', auth.requireAuth, apiRouter);

  // The React panel. Its assets are content-hashed, so they cache for a year
  // while index.html never does — a stale shell would load a build that no
  // longer exists.
  const uiDir = path.join(__dirname, 'public-ui');
  const hasUi = fs.existsSync(path.join(uiDir, 'index.html'));

  if (hasUi) {
    app.use(
      '/ui/assets',
      auth.requireAuth,
      express.static(path.join(uiDir, 'assets'), {
        immutable: true,
        maxAge: '365d',
      })
    );
    // Client-side routing: every /ui path serves the same shell.
    app.get(/^\/ui(\/.*)?$/, auth.requireAuth, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.sendFile(path.join(uiDir, 'index.html'));
    });
  }

  app.get('/', auth.requireAuth, (req, res) => {
    if (hasUi) return res.redirect('/ui/');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Never cache the panel's own assets: after a redesign the browser kept
  // serving the old stylesheet for an hour and the change looked undone.
  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      etag: true,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
    })
  );

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error('unhandled request error', { path: req.path, error: err.message });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

const PROVIDER_KEYS = (health) => {
  const out = {};
  for (const [k, v] of Object.entries(health)) if (v && typeof v === 'object' && 'available' in v) out[k] = v.available;
  return out;
};

function start() {
  return new Promise((resolve, reject) => {
    const app = createServer();
    const server = app.listen(config.admin.port, config.admin.host, () => {
      log.info(`Admin panel → http://${config.admin.host}:${config.admin.port}`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') log.error(`Port ${config.admin.port} band. .env dagi ADMIN_PORT ni o'zgartiring.`);
      reject(err);
    });
    // Long-lived SSE connections need a generous timeout.
    server.headersTimeout = 120_000;
    server.requestTimeout = 0;
  });
}

module.exports = { start, createServer };
