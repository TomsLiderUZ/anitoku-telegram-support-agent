'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { db, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const projects = require('./projects');
const shell = require('./shell');

const log = createLogger('sites');

/**
 * Web projects: run them locally on their own port, or publish them to the
 * server behind a subdomain.
 *
 * "Build a site" should end with a URL the founder can open, not with a plan.
 * Locally that means a free port and a running process; on the server it means
 * the code copied over, kept alive by pm2, and reachable over HTTPS through an
 * nginx vhost. DNS is the one step nobody can automate from here — when the
 * record is missing we still set everything up and say exactly what to add.
 */

const PORT_MIN = 3200;
const PORT_MAX = 3999;

/** Is a TCP port free on this machine right now? */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** A port nobody else has claimed — checked against both the OS and our own projects. */
async function allocatePort(slug) {
  const taken = new Set(
    projects
      .list({ all: true })
      .map((p) => Number(projects.envOf(p.slug).PORT))
      .filter(Boolean)
  );
  const mine = Number(projects.envOf(slug).PORT);
  if (mine && !taken.has(mine)) return mine;
  if (mine && (await portFree(mine))) return mine;

  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (taken.has(p)) continue;
    if (await portFree(p)) {
      projects.setEnv(slug, { PORT: String(p) });
      log.info('port ajratildi', { slug, port: p });
      return p;
    }
  }
  throw new Error('boʻsh port topilmadi');
}

const SITE_BRIEF = (port) => `This is a web project. Requirements:
- Entry point index.js, started by "node index.js".
- Listen on process.env.PORT (currently ${port}) and 0.0.0.0 — never a hardcoded port.
- Serve real HTML: a working page, not a JSON stub. Static assets from a public/ folder.
- Prefer node: builtins and global fetch; install a package only if it genuinely helps.
- Respond to GET / with the main page and return 404 with a readable message for unknown paths.
- All user-facing text in Uzbek (Latin script). Mobile-friendly layout.
- Log each request on one line; never crash on a bad request.
- Verify before finishing: node --check index.js, start it in the BACKGROUND
  (node index.js > run.log 2>&1 & echo $!), curl http://127.0.0.1:${port}/ and confirm
  real HTML comes back, then kill the pid.`;

/**
 * Build (or extend) a web project and leave it running locally.
 * Returns the local URL so the founder can open it immediately.
 */
async function build({ name, spec, fix = null, slug = null, onStep = null }) {
  const coder = require('./coder');
  const s = projects.slugify(slug || name);
  let p = projects.record(s);
  if (!p) {
    p = projects.create({ name, slug: s, kind: 'web', spec, runCmd: 'node index.js' });
  } else if (spec) {
    projects.update(s, { spec });
  }

  const port = await allocatePort(s);
  const existing = fs.existsSync(path.join(p.dir, 'index.js'));
  const task = existing
    ? `Modify the existing web project.\n\nWHAT TO CHANGE:\n${fix || spec}\n\nEverything that already works must keep working — read index.js first.\n\n${SITE_BRIEF(port)}`
    : `Build a website from scratch in this project.\n\nWHAT IT MUST CONTAIN:\n${spec || fix}\n\n${SITE_BRIEF(port)}`;

  if (p.alive) projects.stop(s);
  const r = await coder.runTask({ project: projects.record(s), task, onStep });

  let started = null;
  try {
    await projects.restart(s);
    started = true;
  } catch (err) {
    started = err.message;
  }

  // Prove it answers before claiming it is up.
  await new Promise((res) => setTimeout(res, 2500));
  const probe = await shell.run(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ || true`, { sessionId: `site-${s}`, timeoutMs: 20_000 });
  const httpCode = String(probe.output || '').trim().slice(-3);

  return {
    ...r,
    project: s,
    port,
    started,
    url: `http://localhost:${port}`,
    httpCheck: /^[23]\d\d$/.test(httpCode) ? { ok: true, status: httpCode } : { ok: false, status: httpCode || 'javob yoʻq', logs: projects.logs(s, 12) },
  };
}

// ── publishing to the server ─────────────────────────────────────────────────

const NGINX = (domain, port) => `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
}
`;

/**
 * Copy a project to the server, keep it alive with pm2, and put it behind
 * `domain` over nginx. HTTPS is issued when the DNS record already points
 * here; otherwise the site works over HTTP and we say what to add.
 */
async function publish({ project, domain, host = null, remotePort = null }) {
  const p = projects.find(project);
  if (!p) throw new Error(`loyiha topilmadi: ${project}`);
  if (!domain) throw new Error('subdomen kerak, masalan anime.anitoku.uz');

  const target = host || (shell.listHosts()[0] || {}).name;
  if (!target) throw new Error('server ulanmagan — avval IP va parolni bering');

  const slug = p.slug;
  const port = remotePort || Number(projects.envOf(slug).PORT) || (await allocatePort(slug));
  const remoteDir = `/var/www/${slug}`;
  const sid = `publish-${slug}`;
  const steps = [];
  const step = (name, r) => {
    steps.push({ name, ok: r.ok, out: String(r.output || '').slice(-400) });
    return r;
  };

  // 1. Ship the code (node_modules is rebuilt on the far side).
  const tar = path.join(require('../config').dataDir, `${slug}-publish.tgz`);
  const packed = await shell.run(
    `cd ${JSON.stringify(p.dir)} && tar czf ${JSON.stringify(tar)} --exclude=node_modules --exclude=.git --exclude='*.log' --exclude=.pid .`,
    { sessionId: sid, timeoutMs: 120_000 }
  );
  step('paketlash', packed);
  if (!packed.ok) throw new Error(`Paketlab boʻlmadi: ${packed.output.slice(-200)}`);

  const h = shell.getHost(target);
  const keyFile = path.join(require('../config').dataDir, 'ssh', 'id_ed25519');
  const scp = await shell.run(
    `scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -P ${h.port || 22} -i ${JSON.stringify(keyFile)} ${JSON.stringify(tar)} ${h.user}@${h.host}:/tmp/${slug}.tgz`,
    { sessionId: sid, timeoutMs: 300_000 }
  );
  step('yuborish', scp);
  if (!scp.ok) throw new Error(`Serverga yuborib boʻlmadi: ${scp.output.slice(-200)}`);
  fs.rmSync(tar, { force: true });

  // 2. Unpack, install, and hand it to pm2 on the chosen port.
  const env = projects.envOf(slug);
  const envLine = Object.entries({ ...env, PORT: String(port), NODE_ENV: 'production' })
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');

  const remote = await shell.run(
    [
      `mkdir -p ${remoteDir}`,
      `tar xzf /tmp/${slug}.tgz -C ${remoteDir}`,
      `rm -f /tmp/${slug}.tgz`,
      `cd ${remoteDir}`,
      `export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH`,
      `[ -f package.json ] && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true`,
      `pm2 delete ${slug} >/dev/null 2>&1 || true`,
      `${envLine} pm2 start ${JSON.stringify(p.run_cmd || 'node index.js')} --name ${slug} --interpreter /root/.nvm/versions/node/v22.23.2/bin/node --update-env`,
      `pm2 save >/dev/null 2>&1 || true`,
      `sleep 2 && curl -s -o /dev/null -w "app:%{http_code}" http://127.0.0.1:${port}/ || true`,
    ].join(' && '),
    { sessionId: sid, target: 'remote', host: target, timeoutMs: 300_000 }
  );
  step('ishga tushirish', remote);

  // 3. nginx vhost.
  const conf = `/etc/nginx/sites-available/${domain}`;
  const nginx = await shell.run(
    [
      `cat > ${conf} <<'NGINXCONF'\n${NGINX(domain, port)}NGINXCONF`,
      `ln -sf ${conf} /etc/nginx/sites-enabled/${domain}`,
      `nginx -t && systemctl reload nginx && echo NGINX_OK`,
    ].join(' && '),
    { sessionId: sid, timeoutMs: 90_000 }
  );
  step('nginx', nginx);

  // 4. HTTPS, but only once DNS actually points at this machine.
  const dns = await shell.run(`getent hosts ${domain} | awk '{print $1}' | head -1`, { sessionId: sid, timeoutMs: 30_000 });
  const resolved = String(dns.output || '').trim();
  const pointsHere = resolved === h.host;
  let ssl = null;
  if (pointsHere) {
    const cert = await shell.run(
      `certbot --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>&1 | tail -5`,
      { sessionId: sid, timeoutMs: 180_000 }
    );
    step('https', cert);
    ssl = cert.ok || /Congratulations|successfully|Certificate not yet due/i.test(cert.output);
  }

  const appCode = (String(remote.output || '').match(/app:(\d{3})/) || [])[1];
  projects.setDeployed(slug, true);
  projects.update(slug, { kind: p.kind === 'web' ? 'web' : p.kind });
  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE slug = ?").run(slug);
  recordEvent('sites', 'Site published', { slug, domain, port, ssl: !!ssl });
  log.info('sayt nashr qilindi', { slug, domain, port, ssl: !!ssl, dns: resolved || 'yoʻq' });

  return {
    ok: !!appCode && /^[23]/.test(appCode),
    project: slug,
    domain,
    port,
    url: ssl ? `https://${domain}` : `http://${domain}`,
    appStatus: appCode || 'javob yoʻq',
    ssl: !!ssl,
    dns: pointsHere
      ? { ok: true, resolved }
      : {
          ok: false,
          resolved: resolved || null,
          action: `DNS yozuvini qoʻshing: ${domain} → A → ${h.host}. Yozuv tarqalgach HTTPS avtomatik ulanadi.`,
        },
    steps,
  };
}

/** Re-issue HTTPS for a domain whose DNS has since started resolving. */
async function secure(domain, host = null) {
  const target = host || (shell.listHosts()[0] || {}).name;
  const r = await shell.run(
    `certbot --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>&1 | tail -6`,
    { sessionId: `ssl-${domain}`, target: 'remote', host: target, timeoutMs: 180_000 }
  );
  return { ok: /Congratulations|successfully|not yet due/i.test(r.output), output: r.output.slice(-500) };
}

module.exports = { build, publish, secure, allocatePort, portFree, PORT_MIN, PORT_MAX };
