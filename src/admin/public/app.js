'use strict';

// ── helpers ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'ok', ms = 3800) {
  const t = el('div', `toast ${kind}`, msg);
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, ms);
}

const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('uz-UZ'));
const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}k ${h}s`;
  if (h) return `${h}s ${m}d`;
  return `${m}d ${s % 60}s`;
};
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// ── navigation ──────────────────────────────────────────────────────────────
const loaders = {};
let currentPage = 'dashboard';

document.querySelectorAll('.nav-item[data-page]').forEach((n) => {
  n.addEventListener('click', () => go(n.dataset.page));
});

function go(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  location.hash = page;
  if (loaders[page]) loaders[page]().catch((e) => toast(e.message, 'err'));
}

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login';
});

// ── dashboard ───────────────────────────────────────────────────────────────
let lastStatus = null;

loaders.dashboard = async () => {
  const s = await api('/status');
  lastStatus = s;

  const a = s.agent, t = s.telegram;
  const stats = [
    { label: 'Agent holati', value: a.paused ? 'Pauza' : t.connected ? 'Faol' : 'Kutmoqda', cls: a.paused ? 'warn' : t.connected ? 'ok' : 'err', sub: `uptime ${fmtDur(s.system.uptimeSec)}` },
    { label: 'Javoblar (24s)', value: fmtNum(a.replies24h), sub: `jami ${fmtNum(a.replied)} shu sessiyada` },
    { label: 'Kelgan xabar (24s)', value: fmtNum(a.incoming24h), sub: `navbatda ${a.queued}` },
    { label: 'Eskalatsiya', value: fmtNum(a.openEscalations), cls: a.openEscalations > 0 ? 'warn' : '', sub: 'ochiq murojaatlar' },
    { label: 'Bilim hujjatlari', value: fmtNum(s.knowledge.documents), sub: `${fmtNum(s.knowledge.qaPairs)} savol-javob` },
    { label: "Ko'nikmalar", value: fmtNum(s.skills), sub: s.prompt ? `prompt v${s.prompt.version}` : 'prompt yo\'q' },
    { label: 'AI chaqiruv (24s)', value: fmtNum(s.ai.calls24h), sub: `${fmtNum(s.ai.avgLatencyMs)}ms o'rtacha` },
    { label: 'Xotira', value: `${s.system.rssMb}MB`, sub: `node ${s.system.node}` },
  ];

  $('statGrid').innerHTML = stats
    .map((x) => `<div class="stat ${x.cls || ''}"><div class="stat-label">${esc(x.label)}</div><div class="stat-value">${esc(x.value)}</div><div class="stat-sub">${esc(x.sub || '')}</div></div>`)
    .join('');

  const pill = $('agentPill');
  pill.className = 'pill ' + (a.paused ? 'warn' : t.connected ? 'ok' : 'err');
  pill.innerHTML = `<span class="dot ${t.connected && !a.paused ? 'pulse' : ''}"></span> ${a.paused ? 'Pauzada' : t.connected ? 'Ishlamoqda' : 'Ulanmagan'}`;
  $('togglePause').textContent = a.paused ? 'Davom ettirish' : 'Pauza';

  const keyRows = Object.entries(s.keys)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => `<div class="row" style="justify-content:space-between;padding:5px 0"><span>${esc(k)}</span><span class="row">
        <span class="pill ${v.available ? 'ok' : 'err'}">${v.available} faol</span>
        ${v.cooldown ? `<span class="pill warn">${v.cooldown} kutish</span>` : ''}
        ${v.dead ? `<span class="pill err">${v.dead} nosoz</span>` : ''}
      </span></div>`)
    .join('');

  $('healthBox').innerHTML = `
    <div class="row" style="justify-content:space-between;padding:5px 0"><span>Telegram</span>
      <span class="pill ${t.connected ? 'ok' : 'err'}"><span class="dot"></span> ${esc(t.status)}${t.username ? ' · @' + esc(t.username) : ''}</span></div>
    <div class="row" style="justify-content:space-between;padding:5px 0"><span>Avto javob</span>
      <span class="pill ${a.autoReply ? 'ok' : 'warn'}">${a.autoReply ? 'yoqilgan' : "o'chirilgan"}</span></div>
    ${keyRows}
    <div class="row" style="justify-content:space-between;padding:5px 0"><span>Oxirgi trening</span>
      <span class="pill">${s.training.lastAt ? fmtTime(s.training.lastAt) : 'hech qachon'}</span></div>`;

  $('aiUsageBox').innerHTML = s.ai.byModel.length
    ? `<div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Chaqiruv</th><th class="num">Muvaffaqiyat</th></tr></thead><tbody>${s.ai.byModel
        .map((m) => `<tr><td class="mono">${esc(m.provider)}/${esc(m.model)}</td><td class="num">${m.calls}</td><td class="num">${Math.round((m.ok / m.calls) * 100)}%</td></tr>`)
        .join('')}</tbody></table></div>
       <div class="hint" style="margin-top:10px">Tokenlar: ${fmtNum(s.ai.tokensIn24h)} kirish · ${fmtNum(s.ai.tokensOut24h)} chiqish</div>`
    : '<div class="empty">Hali AI chaqiruvlari yo\'q</div>';

  const badge = $('escBadge');
  badge.hidden = !a.openEscalations;
  badge.textContent = a.openEscalations;
};

$('togglePause').addEventListener('click', async () => {
  const wantPause = !(lastStatus && lastStatus.agent.paused);
  if (wantPause === false && !confirm('Agent JONLI javob berishni boshlaydi — haqiqiy foydalanuvchilarga xabar yuboradi. Davom etamizmi?')) return;
  const r = await api('/agent/state', { method: 'POST', body: { paused: wantPause } });
  toast(r.live ? 'Agent JONLI — haqiqiy chatlarga javob beradi' : 'Agent toʻxtatildi', r.live ? 'warn' : 'ok', 6000);
  loaders.dashboard();
});

// ── telegram ────────────────────────────────────────────────────────────────
loaders.telegram = async () => renderTelegram(await api('/telegram'));

const TG_STATUS_LABEL = {
  connected: 'ulangan',
  awaiting_qr: 'QR skan kutilmoqda',
  awaiting_code: 'kod kutilmoqda',
  awaiting_password: '2FA parol kutilmoqda',
  connecting: 'ulanmoqda',
  error: 'xato',
  disconnected: 'ulanmagan',
};

function renderTelegram(info) {
  const pill = $('tgPill');
  const map = { connected: 'ok', awaiting_qr: 'info', awaiting_code: 'warn', awaiting_password: 'warn', connecting: 'info', error: 'err', disconnected: '' };
  pill.className = 'pill ' + (map[info.status] || '');
  pill.innerHTML = `<span class="dot ${info.connected ? 'pulse' : ''}"></span> ${esc(TG_STATUS_LABEL[info.status] || info.status)}`;

  const connected = info.connected;
  $('tgConnected').hidden = !connected;
  $('tgSetup').hidden = connected;
  $('tgCodeBox').hidden = info.status !== 'awaiting_code';
  $('tgPassBox').hidden = info.status !== 'awaiting_password';
  $('tgErr').textContent = info.lastError || '';

  // The QR flow reaches the 2FA step too — stop polling once it is scanned.
  // 'connecting' is transient between token refreshes, so it must not stop it.
  if (info.status !== 'awaiting_qr' && info.status !== 'connecting') stopQrPoll();
  if (info.status === 'awaiting_password' && qrWasActive) {
    $('tgQrBox').innerHTML = '<div class="qr-scanned">✅ QR skanlandi — endi 2FA parolingizni kiriting</div>';
  }

  if (connected) {
    $('tgWho').textContent = `${info.firstName || ''} ${info.username ? '@' + info.username : ''} · ${info.userId || ''}`;
    $('tgDetails').innerHTML = `Raqam: ${esc(info.phone || '—')}<br>Ulangan: ${fmtTime(info.connectedAt)}<br>Sessiya uptime: ${fmtDur(info.uptimeSec)}`;
  }
  if (info.hasApi && !connected) {
    $('tgConnectBtn').textContent = info.hasSession ? 'Qayta ulanish' : 'Kod yuborish';
    // Credentials are already stored (and never sent back) — mark the fields as set.
    for (const id of ['tgApiId', 'tgApiHash']) {
      if (!$(id).value) $(id).placeholder = '••••••  (saqlangan)';
    }
  }
}

// ── QR login ────────────────────────────────────────────────────────────────
let qrTimer = null;
let qrWasActive = false;

document.querySelectorAll('[data-tgtab]').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('[data-tgtab]').forEach((x) => x.classList.toggle('active', x === t));
    $('tgtab-qr').hidden = t.dataset.tgtab !== 'qr';
    $('tgtab-phone').hidden = t.dataset.tgtab !== 'phone';
    if (t.dataset.tgtab !== 'qr') stopQrPoll();
  })
);

function stopQrPoll() {
  clearInterval(qrTimer);
  qrTimer = null;
}

function paintQr(state) {
  if (state.svg) {
    qrWasActive = true;
    $('tgQrBox').classList.remove('loading');
    $('tgQrBox').innerHTML = state.svg;
    $('tgQrTimer').textContent = state.expiresInSec ? `${state.expiresInSec}s ichida yangilanadi` : '';
  } else if (state.error) {
    $('tgQrBox').innerHTML = `<div class="qr-empty" style="color:#b33">${esc(state.error)}</div>`;
  }
}

$('tgQrBtn').addEventListener('click', async () => {
  const btn = $('tgQrBtn');
  const apiId = $('tgApiId').value.trim();
  const apiHash = $('tgApiHash').value.trim();

  btn.disabled = true;
  btn.textContent = 'Olinmoqda…';
  $('tgQrBox').classList.add('loading');
  $('tgQrBox').innerHTML = '<div class="qr-empty">QR kod tayyorlanmoqda…</div>';

  try {
    const state = await api('/telegram/qr', { method: 'POST', body: { apiId: apiId || null, apiHash: apiHash || null } });
    paintQr(state);
    renderTelegram(state.info);
    if (state.url) {
      toast('QR kod tayyor — telefondan skan qiling', 'ok', 6000);
      startQrPoll();
    }
  } catch (err) {
    toast(err.message, 'err');
    $('tgQrBox').innerHTML = `<div class="qr-empty" style="color:#b33">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'QR kodni yangilash';
    $('tgQrBox').classList.remove('loading');
  }
});

/** Telegram rotates the token every ~30s; poll so the displayed code stays valid. */
function startQrPoll() {
  stopQrPoll();
  qrTimer = setInterval(async () => {
    try {
      const state = await api('/telegram/qr');
      renderTelegram(state.info);
      if (state.info.connected) {
        stopQrPoll();
        toast('Telegram muvaffaqiyatli ulandi ✅', 'ok', 6000);
        return;
      }
      if (state.status === 'awaiting_qr') paintQr(state);
    } catch {
      /* transient — keep polling */
    }
  }, 2500);
}

$('tgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('tgConnectBtn');
  btn.disabled = true;
  btn.textContent = 'Ulanmoqda…';
  try {
    const out = await api('/telegram/connect', {
      method: 'POST',
      body: {
        apiId: $('tgApiId').value.trim(),
        apiHash: $('tgApiHash').value.trim(),
        phone: $('tgPhone').value.trim(),
        forceSms: $('tgForceSms').checked,
      },
    });
    renderTelegram(out.info);
    toast(out.status === 'awaiting_code' ? 'Kod yuborildi — Telegramni tekshiring' : `Holat: ${out.status}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
    $('tgErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kod yuborish';
  }
});

$('tgCodeBtn').addEventListener('click', async () => {
  const btn = $('tgCodeBtn');
  btn.disabled = true;
  try {
    const out = await api('/telegram/code', { method: 'POST', body: { code: $('tgCode').value.trim() } });
    renderTelegram(out.info);
    toast(out.status === 'connected' ? 'Muvaffaqiyatli ulandi ✅' : `Holat: ${out.status}`, out.status === 'error' ? 'err' : 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('tgPassBtn').addEventListener('click', async () => {
  const btn = $('tgPassBtn');
  btn.disabled = true;
  try {
    const out = await api('/telegram/password', { method: 'POST', body: { password: $('tgPass').value } });
    renderTelegram(out.info);
    toast(out.status === 'connected' ? 'Muvaffaqiyatli ulandi ✅' : `Holat: ${out.status}`, out.status === 'error' ? 'err' : 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('tgLogout').addEventListener('click', async () => {
  if (!confirm('Telegram akkauntni uzasizmi? Sessiya o\'chiriladi.')) return;
  const out = await api('/telegram/logout', { method: 'POST', body: { revoke: false } });
  renderTelegram(out.info);
  toast('Uzildi', 'warn');
});

async function loadDialogs() {
  try {
    const list = await api('/telegram/dialogs?limit=150');
    $('tgDialogs').innerHTML = list.length
      ? list.map((d) => `<tr><td>${esc(d.title)}</td><td><span class="pill">${esc(d.type)}</span></td><td class="mono">${esc(d.id)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">Chat topilmadi</td></tr>';
  } catch (err) {
    toast(err.message, 'err');
  }
}
$('tgLoadDialogs').addEventListener('click', loadDialogs);
$('tgRefreshDialogs').addEventListener('click', loadDialogs);

// ── keys ────────────────────────────────────────────────────────────────────
loaders.keys = async () => {
  const d = await api('/keys');
  renderKeys(d);
  loadTokens().catch(() => {});
};

/** Token accounting — where the free-tier budget actually goes. */
async function loadTokens() {
  const t = await api('/tokens');
  const card = (label, w, sub) =>
    `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${fmtNum(w.tokensTotal)}</div>
     <div class="stat-sub">${fmtNum(w.tokensIn)} kirish · ${fmtNum(w.tokensOut)} chiqish</div>
     <div class="stat-sub">${esc(sub)}</div></div>`;

  $('tokenTotals').innerHTML =
    card('Jami (butun vaqt)', t.lifetime, `${fmtNum(t.lifetime.calls)} chaqiruv · ${fmtNum(t.lifetime.failed)} xato`) +
    card('So\'nggi 24 soat', t.last24h, `${fmtNum(t.last24h.calls)} chaqiruv · ${t.last24h.avgLatencyMs}ms`) +
    card('So\'nggi 7 kun', t.last7d, `${fmtNum(t.last7d.calls)} chaqiruv`) +
    `<div class="stat"><div class="stat-label">Muvaffaqiyat</div><div class="stat-value">${
      t.lifetime.calls ? Math.round((t.lifetime.ok / t.lifetime.calls) * 100) : 0
    }%</div><div class="stat-sub">${fmtNum(t.lifetime.ok)} / ${fmtNum(t.lifetime.calls)}</div>
    <div class="stat-sub">o'rtacha ${t.lifetime.avgLatencyMs}ms</div></div>`;

  $('tokenByProvider').innerHTML = t.byProvider.length
    ? t.byProvider
        .map((p) => `<tr><td><span class="pill">${esc(p.provider)}</span></td><td class="num">${fmtNum(p.calls)}</td>
           <td class="num">${fmtNum(p.tokensIn)}</td><td class="num">${fmtNum(p.tokensOut)}</td>
           <td class="num"><b>${fmtNum(p.tokensTotal)}</b></td><td class="num">${p.avgLatencyMs}</td></tr>`)
        .join('')
    : '<tr><td colspan="6" class="empty">Ma\'lumot yo\'q</td></tr>';

  $('tokenByPurpose').innerHTML = t.byPurpose.length
    ? t.byPurpose.map((p) => `<tr><td>${esc(p.purpose || '—')}</td><td class="num">${fmtNum(p.calls)}</td><td class="num">${fmtNum(p.tokensTotal)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Ma\'lumot yo\'q</td></tr>';

  $('tokenByKey').innerHTML = t.byKey.length
    ? t.byKey
        .map((k) => `<tr><td><span class="pill">${esc(k.provider)}</span></td><td class="mono">${esc(k.key_mask || '')}</td>
           <td><span class="pill ${k.status === 'active' ? 'ok' : k.status === 'dead' ? 'err' : 'warn'}">${esc(k.status)}</span></td>
           <td class="num">${fmtNum(k.successes)}</td><td class="num">${fmtNum(k.failures)}</td><td class="num">${fmtNum(k.tokens_used)}</td></tr>`)
        .join('')
    : '<tr><td colspan="6" class="empty">Ma\'lumot yo\'q</td></tr>';
}

$('tokensRefresh').addEventListener('click', () => loadTokens().catch((e) => toast(e.message, 'err')));

function renderKeys(d) {
  // Provider roster with sign-up links. Adding a second provider is the single
  // most effective cure for "the agent went quiet because keys ran out".
  if (d.providers) {
    $('providerList').innerHTML = d.providers
      .map((p) => {
        const h = (d.health && d.health[p.id]) || { total: 0, available: 0 };
        const cls = h.total ? (h.available ? 'ok' : 'warn') : '';
        const count = h.total ? `${h.available}/${h.total}` : 'kalit yo\'q';
        const link = p.signup ? ` <a href="${esc(p.signup)}" target="_blank" rel="noopener">olish ↗</a>` : '';
        return `<span class="pill ${cls}" style="gap:6px">${esc(p.label)} · ${esc(count)}${link}</span>`;
      })
      .join(' ');

    const sel = $('keysProvider');
    if (sel && sel.options.length <= 1) {
      for (const p of d.providers) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label + (p.prefix ? '' : ' (prefiksiz)');
        sel.appendChild(o);
      }
    }
  }

  $('keyHealth').innerHTML = Object.entries(d.health)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => `<div class="stat ${v.available ? 'ok' : 'err'}"><div class="stat-label">${esc(k)}</div><div class="stat-value">${v.available}/${v.total}</div><div class="stat-sub">${v.cooldown} kutish · ${v.dead} nosoz</div></div>`)
    .join('') + `<div class="stat"><div class="stat-label">Asosiy provayder</div><div class="stat-value" style="font-size:19px">${esc(d.health.primary || '—')}</div><div class="stat-sub">sozlamalardan</div></div>`;

  $('keysTable').innerHTML = d.keys.length
    ? d.keys
        .map((k) => {
          const cls = k.status === 'active' ? 'ok' : k.status === 'cooldown' ? 'warn' : 'err';
          const label = k.status === 'cooldown' ? `kutish ${k.cooldown_left}s` : k.status;
          return `<tr>
            <td>${k.id}</td>
            <td><span class="pill">${esc(k.provider)}</span></td>
            <td class="mono">${esc(k.mask || '')}${k.label ? ` <span style="color:var(--txt-mute)">${esc(k.label)}</span>` : ''}</td>
            <td><span class="pill ${cls}">${esc(label)}</span>${k.last_error ? `<div class="hint" style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(k.last_error)}">${esc(k.last_error)}</div>` : ''}</td>
            <td class="num">${fmtNum(k.successes)}</td>
            <td class="num">${fmtNum(k.failures)}</td>
            <td class="num">${fmtNum(k.tokens_used)}</td>
            <td><div class="row">
              <button class="btn ghost sm" data-test="${k.id}">Sinash</button>
              <button class="btn ghost sm" data-toggle="${k.id}" data-status="${k.status === 'disabled' ? 'active' : 'disabled'}">${k.status === 'disabled' ? 'Yoqish' : "O'chirish"}</button>
              <button class="btn danger sm" data-del="${k.id}">×</button>
            </div></td></tr>`;
        })
        .join('')
    : '<tr><td colspan="8" class="empty">Kalit qo\'shilmagan</td></tr>';

  $('keysTable').querySelectorAll('[data-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = '…';
      const r = await api(`/keys/${b.dataset.test}/test`, { method: 'POST' });
      toast(r.ok ? `✅ Ishlaydi (${r.latencyMs}ms, ${r.model})` : `❌ ${r.error}`, r.ok ? 'ok' : 'err', 5000);
      loaders.keys();
    })
  );
  $('keysTable').querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      renderKeys(await api(`/keys/${b.dataset.toggle}/status`, { method: 'POST', body: { status: b.dataset.status } }).then(() => api('/keys')));
    })
  );
  $('keysTable').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Kalit o\'chirilsinmi?')) return;
      await api(`/keys/${b.dataset.del}`, { method: 'DELETE' });
      loaders.keys();
    })
  );
}

$('keysAdd').addEventListener('click', async () => {
  const keys = $('keysInput').value.trim();
  if (!keys) return toast('Kalit kiriting', 'warn');
  const out = await api('/keys', { method: 'POST', body: { keys, provider: $('keysProvider').value || null, label: $('keysLabel').value || null } });
  toast(`${out.added} qo'shildi · ${out.skipped} takror · ${out.invalid} yaroqsiz`, out.added ? 'ok' : 'warn');
  $('keysInput').value = '';
  renderKeys({ keys: out.keys, health: out.health });
});

$('keysRevive').addEventListener('click', async () => {
  const r = await api('/keys/revive', { method: 'POST' });
  toast(`${r.revived} kalit tiklandi`, 'ok');
  loaders.keys();
});

$('keysTestAll').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Sinalmoqda…';
  try {
    const r = await api('/keys/test-all', { method: 'POST' });
    const ok = r.results.filter((x) => x.ok).length;
    toast(`${ok}/${r.results.length} kalit ishlaydi`, ok ? 'ok' : 'err', 6000);
    loaders.keys();
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Hammasini sinash';
  }
});

// ── training ────────────────────────────────────────────────────────────────
const TRAIN_STEPS = [
  ['seed', 'Seed'], ['ingest', 'Ingest'], ['style', 'Uslub'], ['topics', 'Mavzular'],
  ['prompt', 'Prompt'], ['skills', "Ko'nikma"], ['distill', 'Distill'], ['done', 'Tayyor'],
];

loaders.training = async () => renderTraining(await api('/training'));

function renderTraining(d) {
  const st = d.state;
  const idx = TRAIN_STEPS.findIndex(([k]) => k === st.phase);
  $('trainSteps').innerHTML = TRAIN_STEPS.map(([k, label], i) => {
    const cls = st.phase === 'failed' && i === idx ? 'active' : i < idx ? 'done' : i === idx && st.running ? 'active' : i <= idx && st.phase === 'done' ? 'done' : '';
    return `<div class="step ${cls}"><b>${i + 1}</b>${esc(label)}</div>`;
  }).join('');

  $('trainBar').style.width = (st.progress || 0) + '%';
  $('trainPhase').className = 'pill ' + (st.running ? 'info' : st.phase === 'done' ? 'ok' : st.phase === 'failed' ? 'err' : '');
  $('trainPhase').textContent = st.running ? `${st.phase} · ${st.progress}%` : st.phase;
  $('trainMsg').textContent = st.error || st.message || '';
  $('trainRun').disabled = st.running;
  $('trainRun').textContent = st.running ? 'Ishlamoqda…' : 'Treningni boshlash';

  $('trainStats').textContent = Object.keys(st.stats || {}).length ? JSON.stringify(st.stats, null, 2) : '—';
  $('trainHistory').innerHTML = d.history.length
    ? d.history
        .map((h) => `<tr><td>${h.id}</td><td><span class="pill ${h.status === 'done' ? 'ok' : h.status === 'failed' ? 'err' : 'info'}">${esc(h.status)}</span></td><td>${fmtTime(h.started_at)}</td><td>${h.finished_at ? fmtTime(h.finished_at) : '—'}</td></tr>`)
        .join('')
    : '<tr><td colspan="4" class="empty">Hali trening o\'tkazilmagan</td></tr>';
}

$('trainRun').addEventListener('click', async () => {
  await api('/training/run', { method: 'POST', body: {} });
  toast('Trening boshlandi — bu bir necha daqiqa olishi mumkin', 'ok', 6000);
  pollTraining();
});

let trainTimer = null;
function pollTraining() {
  clearInterval(trainTimer);
  trainTimer = setInterval(async () => {
    try {
      const d = await api('/training');
      renderTraining(d);
      if (!d.state.running) {
        clearInterval(trainTimer);
        toast(d.state.error ? `Trening xatosi: ${d.state.error}` : 'Trening yakunlandi ✅', d.state.error ? 'err' : 'ok', 6000);
      }
    } catch {
      clearInterval(trainTimer);
    }
  }, 2000);
}

// ── knowledge ───────────────────────────────────────────────────────────────
loaders.knowledge = async () => {
  const d = await api(`/knowledge?q=${encodeURIComponent($('kbFilter').value)}&source=${$('kbSource').value}`);
  $('kbStats').innerHTML = `
    <div class="stat"><div class="stat-label">Hujjatlar</div><div class="stat-value">${fmtNum(d.stats.documents)}</div></div>
    <div class="stat"><div class="stat-label">Savol-javob</div><div class="stat-value">${fmtNum(d.stats.qaPairs)}</div></div>
    ${d.stats.bySource.slice(0, 2).map((s) => `<div class="stat"><div class="stat-label">${esc(s.source)}</div><div class="stat-value">${fmtNum(s.c)}</div></div>`).join('')}`;

  $('kbTable').innerHTML = d.items.length
    ? d.items
        .map((k) => `<tr>
          <td>${k.id}</td>
          <td><span class="pill">${esc(k.source)}</span></td>
          <td><b>${esc(k.title || '—')}</b><div class="hint" style="max-width:520px">${esc(String(k.preview).slice(0, 170))}…</div></td>
          <td class="num">${k.weight}</td>
          <td><button class="btn danger sm" data-kbdel="${k.id}">×</button></td></tr>`)
        .join('')
    : '<tr><td colspan="5" class="empty">Hujjat yo\'q</td></tr>';

  $('kbTable').querySelectorAll('[data-kbdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/knowledge/${b.dataset.kbdel}`, { method: 'DELETE' });
      loaders.knowledge();
    })
  );
};

$('kbFilter').addEventListener('input', debounce(() => loaders.knowledge(), 400));
$('kbSource').addEventListener('change', () => loaders.knowledge());

$('kbAdd').addEventListener('click', async () => {
  const content = $('kbContent').value.trim();
  if (content.length < 8) return toast('Matn juda qisqa', 'warn');
  await api('/knowledge', { method: 'POST', body: { title: $('kbTitle').value, content, tags: $('kbTags').value } });
  $('kbTitle').value = $('kbContent').value = $('kbTags').value = '';
  toast('Qo\'shildi', 'ok');
  loaders.knowledge();
});

$('kbSeed').addEventListener('click', async () => {
  const r = await api('/knowledge/seed', { method: 'POST' });
  toast(`Seed yuklandi (${r.documents} hujjat)`, 'ok');
  loaders.knowledge();
});

$('kbIngest').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Ingest…';
  try {
    const r = await api('/ingest', { method: 'POST' });
    toast(`Kanal: ${r.channel?.docs || 0} post · Chatlar: ${r.dialogs?.messages || 0} xabar`, 'ok', 6000);
    loaders.knowledge();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Telegramdan ingest';
  }
});

$('kbSearchBtn').addEventListener('click', async () => {
  const r = await api('/knowledge/search', { method: 'POST', body: { q: $('kbSearchQ').value, limit: 6 } });
  $('kbSearchOut').hidden = false;
  $('kbSearchOut').textContent = r.results.length
    ? r.results.map((x) => `[${x.score.toFixed(1)}] ${x.title || x.source}\n${String(x.content).slice(0, 260)}\n`).join('\n')
    : 'Natija topilmadi';
});

// ── skills ──────────────────────────────────────────────────────────────────
loaders.skills = async () => {
  const list = await api('/skills');
  $('skillsTable').innerHTML = list.length
    ? list
        .map((s) => `<tr>
          <td><b>${esc(s.name)}</b><div class="hint">${esc(s.description || '')}</div></td>
          <td class="hint" style="max-width:270px">${esc(String(s.triggers || '').slice(0, 90))}</td>
          <td class="num">${s.priority}</td>
          <td><span class="pill">${s.auto_generated ? 'auto' : "qo'lda"}</span></td>
          <td><span class="pill ${s.enabled ? 'ok' : ''}">${s.enabled ? 'faol' : "o'chiq"}</span></td>
          <td><div class="row">
            <button class="btn ghost sm" data-skedit="${esc(s.slug)}">Tahrir</button>
            <button class="btn ghost sm" data-sktoggle="${esc(s.slug)}" data-on="${s.enabled ? 0 : 1}">${s.enabled ? "O'chirish" : 'Yoqish'}</button>
            <button class="btn danger sm" data-skdel="${esc(s.slug)}">×</button>
          </div></td></tr>`)
        .join('')
    : '<tr><td colspan="6" class="empty">Ko\'nikma yo\'q — trening o\'tkazing</td></tr>';

  $('skillsTable').querySelectorAll('[data-skedit]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = list.find((x) => x.slug === b.dataset.skedit);
      openSkill(s);
    })
  );
  $('skillsTable').querySelectorAll('[data-sktoggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/skills/${b.dataset.sktoggle}/toggle`, { method: 'POST', body: { enabled: b.dataset.on === '1' } });
      loaders.skills();
    })
  );
  $('skillsTable').querySelectorAll('[data-skdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Ko\'nikma o\'chirilsinmi?')) return;
      await api(`/skills/${b.dataset.skdel}`, { method: 'DELETE' });
      loaders.skills();
    })
  );
};

function openSkill(s) {
  $('skillEditor').hidden = false;
  $('skSlug').value = s ? s.slug : '';
  $('skName').value = s ? s.name : '';
  $('skDesc').value = s ? s.description || '' : '';
  $('skTriggers').value = s ? s.triggers || '' : '';
  $('skInstructions').value = s ? s.instructions || '' : '';
  $('skExamples').value = s ? s.examples || '' : '';
  $('skPriority').value = s ? s.priority : 100;
  $('skillEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('skillNew').addEventListener('click', () => openSkill(null));
$('skCancel').addEventListener('click', () => ($('skillEditor').hidden = true));

$('skSave').addEventListener('click', async () => {
  const body = {
    slug: $('skSlug').value || null,
    name: $('skName').value.trim(),
    description: $('skDesc').value,
    triggers: $('skTriggers').value,
    instructions: $('skInstructions').value.trim(),
    examples: $('skExamples').value,
    priority: Number($('skPriority').value) || 100,
    enabled: true,
  };
  if (!body.name || !body.instructions) return toast('Nom va ko\'rsatma majburiy', 'warn');
  await api('/skills', { method: 'POST', body });
  toast('Saqlandi', 'ok');
  $('skillEditor').hidden = true;
  loaders.skills();
});

$('skTestBtn').addEventListener('click', async () => {
  const r = await api('/skills/match', { method: 'POST', body: { text: $('skTestInput').value } });
  $('skTestOut').innerHTML = r.length
    ? r.map((s) => `<span class="pill info">${esc(s.name)} · pri ${s.priority}${s.score ? ` · ${s.score.toFixed(1)}` : ''}</span>`).join(' ')
    : '<span class="hint">Mos ko\'nikma topilmadi</span>';
});

// ── prompt ──────────────────────────────────────────────────────────────────
loaders.prompt = async () => {
  const d = await api('/prompts');
  $('promptCore').textContent = d.core;
  $('promptContent').value = d.active ? d.active.content : '';
  $('promptVersions').innerHTML = d.list.length
    ? d.list.map((p) => `<option value="${p.id}" ${p.active ? 'selected' : ''}>v${p.version} ${p.active ? '(faol)' : ''} — ${esc(p.notes || '')}</option>`).join('')
    : '<option value="">Versiya yo\'q</option>';
};

$('promptVersions').addEventListener('change', async (e) => {
  if (!e.target.value) return;
  const p = await api(`/prompts/${e.target.value}`);
  $('promptContent').value = p.content;
});

$('promptActivate').addEventListener('click', async () => {
  const id = $('promptVersions').value;
  if (!id) return;
  await api(`/prompts/${id}/activate`, { method: 'POST' });
  toast('Faollashtirildi', 'ok');
  loaders.prompt();
});

$('promptSave').addEventListener('click', async () => {
  const content = $('promptContent').value.trim();
  if (content.length < 50) return toast('Prompt juda qisqa', 'warn');
  const r = await api('/prompts', { method: 'POST', body: { content, notes: 'qo\'lda tahrirlangan' } });
  toast(`Saqlandi va faollashtirildi (v${r.version})`, 'ok');
  loaders.prompt();
});

$('promptPreviewBtn').addEventListener('click', async () => {
  const r = await api(`/prompts/preview/runtime?q=${encodeURIComponent($('promptPreviewQ').value)}`);
  $('promptPreview').textContent = r.prompt;
});

// ── chats ───────────────────────────────────────────────────────────────────
let activeChat = null;

loaders.chats = async () => {
  const list = await api('/chats?limit=80');
  $('chatList').innerHTML = list.length
    ? list
        .map((c) => `<div class="chat-item ${activeChat === c.tg_chat_id ? 'active' : ''}" data-chat="${esc(c.tg_chat_id)}">
            <div class="t">${esc(c.title || c.tg_chat_id)}</div>
            <div class="s"><span class="pill ${c.state === 'auto' ? 'ok' : 'warn'}" style="padding:0 6px;font-size:10px">${esc(c.state)}</span>
              <span>${c.replies_count || 0} javob</span>${c.escalated ? '<span class="pill err" style="padding:0 6px;font-size:10px">esc</span>' : ''}</div>
          </div>`)
        .join('')
    : '<div class="empty">Suhbat yo\'q</div>';

  $('chatList').querySelectorAll('[data-chat]').forEach((n) => n.addEventListener('click', () => openChat(n.dataset.chat, list)));
};

async function openChat(chatId, list) {
  activeChat = chatId;
  const info = (list || []).find((c) => c.tg_chat_id === chatId);
  $('chatTitle').textContent = info ? info.title || chatId : chatId;
  $('chatActions').hidden = false;
  $('chatState').value = info ? info.state : 'auto';
  $('chatInput').disabled = false;
  $('chatSend').disabled = false;
  document.querySelectorAll('[data-chat]').forEach((n) => n.classList.toggle('active', n.dataset.chat === chatId));

  const msgs = await api(`/chats/${encodeURIComponent(chatId)}/messages?limit=80`);
  $('chatMessages').innerHTML = msgs.length
    ? msgs
        .map((m) => `<div class="msg ${m.is_outgoing ? (m.is_agent ? 'out agent' : 'out') : 'in'}">${esc(m.text || `[${m.media_type || 'media'}]`)}
          <div class="meta"><span>${esc(m.sender_name || (m.is_outgoing ? 'Biz' : 'Foydalanuvchi'))}</span><span>${fmtTime(m.date)}</span>${m.is_agent ? '<span>🤖</span>' : ''}</div></div>`)
        .join('')
    : '<div class="empty">Xabar yo\'q</div>';
  const box = $('chatMessages');
  box.scrollTop = box.scrollHeight;
}

$('chatState').addEventListener('change', async (e) => {
  if (!activeChat) return;
  await api(`/chats/${encodeURIComponent(activeChat)}/state`, { method: 'POST', body: { state: e.target.value } });
  toast(`Holat: ${e.target.value}`, 'ok');
  loaders.chats();
});

$('chatSend').addEventListener('click', async () => {
  const text = $('chatInput').value.trim();
  if (!text || !activeChat) return;
  $('chatSend').disabled = true;
  try {
    await api(`/chats/${encodeURIComponent(activeChat)}/send`, { method: 'POST', body: { text } });
    $('chatInput').value = '';
    toast('Yuborildi', 'ok');
    setTimeout(() => openChat(activeChat), 900);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('chatSend').disabled = false;
  }
});
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) $('chatSend').click();
});
$('chatsRefresh').addEventListener('click', () => loaders.chats());

$('chatsPrune').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Tekshirilmoqda…';
  try {
    const r = await api('/chats/prune', { method: 'POST', body: {} });
    if (r.skipped) toast('Tozalash oʻtkazib yuborildi: dialog roʻyxati toʻliq emas', 'warn', 6000);
    else toast(r.removed ? r.removed + ' ta tark etilgan chat oʻchirildi' : 'Tark etilgan chat topilmadi', 'ok');
    loaders.chats();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Tark etilganlarni tozalash';
  }
});

// ── escalations ─────────────────────────────────────────────────────────────
loaders.escalations = async () => {
  const list = await api(`/escalations?status=${$('escFilter').value}`);
  $('escTable').innerHTML = list.length
    ? list
        .map((e2) => {
          const open = e2.status === 'open';
          return `<tr>
          <td>${e2.id}</td>
          <td>${esc(e2.chat_title || e2.tg_chat_id)}<div class="hint mono">${esc(e2.tg_chat_id)}</div></td>
          <td style="max-width:300px"><div>${esc(String(e2.question || '').slice(0, 200))}</div>
            <div class="hint" style="margin-top:4px">${esc(String(e2.draft || '').slice(0, 140))}</div>
            ${e2.answer ? `<div class="hint" style="margin-top:6px;color:var(--ok)">✅ Javob: ${esc(String(e2.answer).slice(0, 160))}</div>` : ''}</td>
          <td style="max-width:200px"><div class="hint">${esc(e2.reason || '')}</div></td>
          <td>${fmtTime(e2.created_at)}</td>
          <td style="min-width:260px">${
            open
              ? `<div class="row" style="align-items:stretch">
                   <textarea data-answer="${e2.id}" placeholder="Javobingizni yozing — agent uni foydalanuvchiga yetkazadi…" style="min-height:56px;flex:1;min-width:180px"></textarea>
                 </div>
                 <div class="row" style="margin-top:6px">
                   <button class="btn ok sm" data-send="${e2.id}">Javobni yuborish</button>
                   <button class="btn ghost sm" data-esc="${e2.id}" data-st="dismissed">Rad etish</button>
                 </div>`
              : `<span class="pill ${e2.status === 'resolved' ? 'ok' : ''}">${esc(e2.status)}</span>`
          }</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty">Eskalatsiya yo\'q</td></tr>';

  $('escTable').querySelectorAll('[data-esc]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/escalations/${b.dataset.esc}/resolve`, { method: 'POST', body: { status: b.dataset.st } });
      loaders.escalations();
    })
  );

  $('escTable').querySelectorAll('[data-send]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.send;
      const box = $('escTable').querySelector(`[data-answer="${id}"]`);
      const text = (box && box.value.trim()) || '';
      if (!text) return toast('Javob matnini yozing', 'warn');
      b.disabled = true;
      b.textContent = 'Yuborilmoqda…';
      try {
        await api(`/escalations/${id}/answer`, { method: 'POST', body: { text } });
        toast('Javob foydalanuvchiga yetkazildi ✅', 'ok');
        loaders.escalations();
      } catch (err) {
        toast(err.message, 'err');
        b.disabled = false;
        b.textContent = 'Javobni yuborish';
      }
    })
  );
};
$('escFilter').addEventListener('change', () => loaders.escalations());

// ── test console ────────────────────────────────────────────────────────────
$('testRun').addEventListener('click', async () => {
  const text = $('testInput').value.trim();
  if (!text) return toast('Savol yozing', 'warn');
  const btn = $('testRun');
  btn.disabled = true;
  btn.textContent = 'Generatsiya…';
  try {
    const r = await api('/test/reply', { method: 'POST', body: { text, userName: $('testName').value || null } });
    $('testOut').innerHTML = r.ok
      ? `<div class="msg in">${esc(text)}<div class="meta"><span>Foydalanuvchi</span></div></div>
         <div class="msg out agent">${esc(r.text)}<div class="meta"><span>Agent</span><span>${r.meta.latencyMs}ms</span></div></div>`
      : `<div class="empty" style="color:var(--err)">Xato: ${esc(r.error)}</div>`;
    $('testMeta').textContent = JSON.stringify(r.meta, null, 2);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Javob generatsiya qilish';
  }
});

// ── settings ────────────────────────────────────────────────────────────────
const SETTING_GROUPS = [
  {
    title: 'Xulq-atvor',
    items: [
      // auto_reply / agent_paused are deliberately absent: the kill switch lives
      // on the dashboard so a stale form cannot silently put the agent live.
      ['reply_to_private', 'Shaxsiy chatlarga javob', 'bool', ''],
      ['reply_in_groups', 'Guruhlarda javob', 'bool', 'O\'chiq bo\'lsa faqat mention/reply da javob beradi'],
      ['typing_simulation', 'Yozayotgan ko\'rinish', 'bool', 'Javob oldidan "typing…" ko\'rsatadi'],
      ['keep_online', 'Doimiy online', 'bool', 'Agent faol bo\'lganda akkaunt Telegramda online ko\'rinadi'],
      ['disclose_ai', 'AI ekanini oshkor qilish', 'bool', 'O\'chiq bo\'lsa jamoa vakili sifatida gapiradi'],
    ],
  },
  {
    title: 'Shaxsiyat',
    items: [
      ['persona_name', 'Agent ismi', 'text', ''],
      ['persona_role', 'Roli', 'text', ''],
      ['language', 'Asosiy til', 'text', 'uz / ru / en'],
    ],
  },
  {
    title: 'Vaqt va limitlar',
    items: [
      ['debounce_ms', 'Debounce (ms)', 'num', 'Ketma-ket xabarlarni kutish vaqti'],
      ['min_delay_ms', 'Minimal kechikish (ms)', 'num', ''],
      ['max_delay_ms', 'Maksimal kechikish (ms)', 'num', ''],
      ['max_replies_per_chat_hour', 'Chat uchun javob/soat', 'num', ''],
      ['max_replies_global_hour', 'Umumiy javob/soat', 'num', ''],
      ['quiet_hours', 'Sokin soatlar', 'text', 'Masalan 01:00-07:00 — bo\'sh bo\'lsa 24/7'],
    ],
  },
  {
    title: 'AI',
    items: [
      ['primary_provider', 'Asosiy provayder', 'select', 'groq|openrouter'],
      ['temperature', 'Temperature', 'text', '0.0 – 1.0'],
      ['max_tokens', 'Maksimal token', 'num', ''],
      ['history_window', 'Suhbat tarixi (xabar)', 'num', ''],
      ['rag_top_k', 'RAG hujjatlar soni', 'num', ''],
      ['skill_top_k', 'Ko\'nikmalar soni', 'num', ''],
    ],
  },
  {
    title: 'Lokal model va yordamchi',
    items: [
      ['local_model_enabled', 'Lokal modeldan foydalanish', 'bool', 'Fayllar bo\'lsa Gemma 3 shu kompyuterda ishlaydi; bo\'lmasa cloud'],
      ['local_purposes', 'Lokal model xizmat qiladigan chaqiruvlar', 'text', 'reply, reply:retry, memory:summary — vergul bilan'],
      ['local_context_size', 'Kontekst hajmi (token)', 'num', 'Standart 8192'],
      ['founder_username', 'Asoschi @username', 'text', 'Yordamchi rejimi faqat shu foydalanuvchi uchun'],
      ['founder_ids', 'Asoschi Telegram ID', 'text', 'Vergul bilan bir nechta bo\'lishi mumkin'],
      ['catchup_enabled', 'Javobsiz qolganlarga javob berish', 'bool', 'Agent o\'chiq bo\'lganda kelgan xabarlarga ishga tushganda javob beradi'],
      ['catchup_max_age_hours', 'Javobsiz xabar yoshi (soat)', 'num', ''],
    ],
  },
  {
    title: "O'qitish",
    items: [
      ['training_channel_id', 'Trening kanal ID', 'text', 'Maxfiy kanal — agent shundan o\'rganadi'],
      ['ingest_dialog_limit', 'Ingest: chat soni', 'num', ''],
      ['ingest_message_limit', 'Ingest: xabar soni', 'num', ''],
      ['auto_retrain_cron_hours', 'Avto qayta trening (soat)', 'num', '0 = o\'chiq'],
    ],
  },
  {
    title: 'Eskalatsiya va filtr',
    items: [
      ['escalation_chat_id', 'Eskalatsiya chat ID', 'text', 'Operator xabarnoma oladigan chat'],
      ['escalate_on_low_confidence', 'Ishonchsizlikda eskalatsiya', 'bool', ''],
      ['blacklist_ids', 'Qora ro\'yxat (ID)', 'text', 'Vergul bilan'],
      ['whitelist_ids', 'Oq ro\'yxat (ID)', 'text', 'To\'ldirilsa faqat shular bilan ishlaydi'],
    ],
  },
];

loaders.settings = async () => {
  const d = await api('/settings');
  const v = d.values;
  $('settingsGrid').innerHTML = SETTING_GROUPS.map(
    (g) => `<div class="card"><div class="card-title">${esc(g.title)}</div>${g.items
      .map(([key, label, type, hint]) => {
        const val = v[key] ?? '';
        if (type === 'bool') {
          return `<label class="switch"><input type="checkbox" data-set="${key}" ${['1', 'true', 'on'].includes(String(val)) ? 'checked' : ''}><span class="track"></span>
            <span class="lbl">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
        }
        if (type === 'select') {
          return `<label class="field"><span>${esc(label)}</span><select data-set="${key}">
            <option value="groq" ${val === 'groq' ? 'selected' : ''}>Groq (tezroq)</option>
            <option value="openrouter" ${val === 'openrouter' ? 'selected' : ''}>OpenRouter (kengroq)</option>
          </select>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
        }
        return `<label class="field"><span>${esc(label)}</span>
          <input type="${type === 'num' ? 'number' : 'text'}" data-set="${key}" value="${esc(val)}">
          ${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
      })
      .join('')}</div>`
  ).join('');
};

$('settingsSave').addEventListener('click', async () => {
  const values = {};
  document.querySelectorAll('[data-set]').forEach((n) => {
    values[n.dataset.set] = n.type === 'checkbox' ? (n.checked ? '1' : '0') : n.value;
  });
  await api('/settings', { method: 'POST', body: { values } });
  toast('Sozlamalar saqlandi', 'ok');
});

$('pwSave').addEventListener('click', async () => {
  try {
    await api('/account/password', { method: 'POST', body: { current: $('pwCurrent').value, next: $('pwNext').value } });
    toast('Parol o\'zgartirildi — qayta kiring', 'ok');
    setTimeout(() => (location.href = '/login'), 1500);
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ── logs ────────────────────────────────────────────────────────────────────
const LEVEL_ORDER = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function logLine(e) {
  const n = el('div', `ln ${e.level}`);
  n.appendChild(el('span', 't', e.ts.slice(11, 19)));
  n.appendChild(el('span', 's', `[${e.scope}]`));
  n.appendChild(el('span', 'm', e.msg + (e.meta ? ' ' + JSON.stringify(e.meta) : '')));
  return n;
}

function appendLog(box, e) {
  if (!box) return;
  const min = LEVEL_ORDER[$('logLevel').value] || 0;
  if (box === $('logConsole') && (LEVEL_ORDER[e.level] || 0) < min) return;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.appendChild(logLine(e));
  while (box.childElementCount > 500) box.removeChild(box.firstChild);
  if (stick) box.scrollTop = box.scrollHeight;
}

loaders.logs = async () => {
  const list = await api(`/logs?limit=300&level=${$('logLevel').value}`);
  $('logConsole').innerHTML = '';
  list.forEach((e) => $('logConsole').appendChild(logLine(e)));
  $('logConsole').scrollTop = $('logConsole').scrollHeight;

  const ev = await api('/events?limit=60');
  $('eventsTable').innerHTML = ev.length
    ? ev.map((x) => `<tr><td>${fmtTime(x.created_at)}</td><td><span class="pill ${x.level === 'error' ? 'err' : x.level === 'warn' ? 'warn' : ''}">${esc(x.type)}</span></td><td>${esc(x.message)}<div class="hint mono">${esc(String(x.meta || '').slice(0, 130))}</div></td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Hodisa yo\'q</td></tr>';
};

$('logLevel').addEventListener('change', () => loaders.logs());
$('logClear').addEventListener('click', () => ($('logConsole').innerHTML = ''));

function connectLogStream() {
  const src = new EventSource('/api/logs/stream');
  src.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data);
      appendLog($('dashConsole'), e);
      appendLog($('logConsole'), e);
    } catch {
      /* ignore malformed frame */
    }
  };
  src.onerror = () => {
    $('liveDot').className = 'pill warn';
    src.close();
    setTimeout(connectLogStream, 4000);
  };
  src.onopen = () => ($('liveDot').className = 'pill info');
}

// ── yordamchi: buyruq berish ────────────────────────────────────────────────
$('asRun').addEventListener('click', async () => {
  const text = $('asInput').value.trim();
  if (!text) return toast("Ko'rsatma yozing", 'warn');
  const btn = $('asRun');
  btn.disabled = true;
  btn.textContent = 'Bajarilmoqda…';
  try {
    const r = await api('/assistant/run', { method: 'POST', body: { text } });
    $('asOut').innerHTML = r.ok
      ? `<div class="msg in">${esc(text)}<div class="meta"><span>Siz</span></div></div>
         <div class="msg out agent">${esc(r.text)}<div class="meta"><span>Yordamchi</span><span>${r.meta.latencyMs || 0}ms</span></div></div>`
      : `<div class="empty" style="color:var(--err)">Xato: ${esc(r.error)}</div>`;
    const m = r.meta || {};
    $('asMeta').textContent = [
      `Vositalar: ${(m.toolsUsed || []).join(', ') || '—'}`,
      m.deterministic && m.deterministic.length ? `Avtomatik: ${JSON.stringify(m.deterministic)}` : null,
      m.forcedTools ? 'Model "bajardim" dedi, lekin vosita chaqirmagan edi — majburlandi' : null,
      `Model: ${m.model || '—'}`,
    ].filter(Boolean).join('\n');
    loaders.tasks && loaders.tasks().catch(() => {});
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Bajarish';
  }
});

// ── vazifalar ───────────────────────────────────────────────────────────────
const TASK_STATUS = { pending: ['Navbatda', 'info'], running: ['Bajarilmoqda', 'warn'], done: ['Bajarildi', 'ok'], failed: ['Xato', 'err'], cancelled: ['Bekor', ''] };
const TASK_KIND = { send_message: 'Xabar yuborish', assistant_run: "Ko'rsatma", create_bot: 'Bot yaratish' };

loaders.tasks = async () => {
  const list = await api(`/tasks?status=${$('taskFilter').value}`);
  const pending = list.filter((t) => t.status === 'pending').length;
  $('taskBadge').hidden = !pending;
  $('taskBadge').textContent = pending;

  $('tasksTable').innerHTML = list.length
    ? list
        .map((t) => {
          const [label, cls] = TASK_STATUS[t.status] || [t.status, ''];
          const res = t.status === 'done' ? (t.result || '') : t.error || '';
          return `<tr>
            <td>${t.id}</td>
            <td><span class="pill ${cls}">${label}</span></td>
            <td><b>${esc(t.title || TASK_KIND[t.kind] || t.kind)}</b><div class="hint">${esc(TASK_KIND[t.kind] || t.kind)}${t.payload && t.payload.to ? ' → ' + esc(t.payload.to) : ''}</div></td>
            <td>${fmtTime(new Date(t.run_at).toISOString())}</td>
            <td style="max-width:300px"><div class="hint">${esc(String(res).replace(/[{}"]/g, '').slice(0, 140))}</div></td>
            <td><div class="row">${t.status === 'pending' ? `<button class="btn ghost sm" data-trun="${t.id}">Hozir</button><button class="btn danger sm" data-tcancel="${t.id}">Bekor</button>` : ''}</div></td></tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty">Vazifa yo\'q</td></tr>';

  $('tasksTable').querySelectorAll('[data-tcancel]').forEach((b) =>
    b.addEventListener('click', async () => { await api(`/tasks/${b.dataset.tcancel}/cancel`, { method: 'POST' }); loaders.tasks(); })
  );
  $('tasksTable').querySelectorAll('[data-trun]').forEach((b) =>
    b.addEventListener('click', async () => { b.disabled = true; await api(`/tasks/${b.dataset.trun}/run`, { method: 'POST' }); toast('Bajarildi', 'ok'); loaders.tasks(); })
  );
};
$('taskFilter').addEventListener('change', () => loaders.tasks());
$('tasksRefresh').addEventListener('click', () => loaders.tasks());

// ── xotira ──────────────────────────────────────────────────────────────────
loaders.memory = async () => {
  const list = await api('/memory');
  $('memCount').textContent = list.length;
  $('memList').innerHTML = list.length
    ? list.map((f) => `<div class="fact-item"><div class="txt">${esc(f.fact)}<div class="when">${fmtTime(f.created_at)}${f.created_by ? ' · ' + esc(f.created_by) : ''}</div></div><button class="btn danger sm" data-mdel="${f.id}">O'chirish</button></div>`).join('')
    : '<div class="empty">Hali fakt saqlanmagan. Telegramda "eslab qol: …" deb yozing yoki shu yerda qo\'shing.</div>';
  $('memList').querySelectorAll('[data-mdel]').forEach((b) =>
    b.addEventListener('click', async () => { await api(`/memory/${b.dataset.mdel}`, { method: 'DELETE' }); loaders.memory(); })
  );
};
$('memAdd').addEventListener('click', async () => {
  const fact = $('memInput').value.trim();
  if (fact.length < 4) return toast('Fakt juda qisqa', 'warn');
  await api('/memory', { method: 'POST', body: { fact } });
  $('memInput').value = '';
  toast('Saqlandi', 'ok');
  loaders.memory();
});

// ── lokal model ─────────────────────────────────────────────────────────────
const gb = (b) => (b / 1073741824).toFixed(2) + ' GB';

loaders.local = async () => {
  const s = await api('/local');
  $('localDir').textContent = s.modelsDir;
  const v = s.vectors || {};
  $('localStats').innerHTML = `
    <div class="stat ${s.chat.loaded ? 'ok' : ''}"><div class="stat-label">Chat modeli</div><div class="stat-value" style="font-size:18px">${s.chat.loaded ? 'Yuklangan' : s.chat.present ? 'Tayyor' : s.chat.downloading ? 'Yuklanmoqda' : "Yo'q"}</div><div class="stat-sub">${esc(s.chat.label)}</div></div>
    <div class="stat ${s.embed.loaded ? 'ok' : ''}"><div class="stat-label">Embedding</div><div class="stat-value" style="font-size:18px">${s.embed.loaded ? 'Yuklangan' : s.embed.present ? 'Tayyor' : "Yo'q"}</div><div class="stat-sub">${esc(s.embed.label)}</div></div>
    <div class="stat"><div class="stat-label">Tezlatgich</div><div class="stat-value" style="font-size:18px">${esc(String(s.gpu || '—').toUpperCase())}</div><div class="stat-sub">${s.calls ? s.calls + ' chaqiruv · ' + s.avgMs + 'ms' : 'hali ishlatilmagan'}</div></div>
    <div class="stat"><div class="stat-label">Semantik indeks</div><div class="stat-value" style="font-size:18px">${fmtNum(v.embedded || 0)} / ${fmtNum(v.documents || 0)}</div><div class="stat-sub">${v.dim ? v.dim + ' o\'lchov' : 'indeks yo\'q'}</div></div>`;

  const row = (m, kind) => `<div class="model-card"><div><div class="name">${esc(m.label)}</div><div class="sub">${esc(m.file)} · ${m.sizeGb} GB${m.present ? ' · diskda ' + gb(m.bytes) : m.downloading ? ' · yuklanmoqda ' + gb(m.bytes) : ''}</div></div>
    <span class="pill ${m.loaded ? 'ok' : m.present ? 'info' : m.downloading ? 'warn' : ''}">${m.loaded ? 'xotirada' : m.present ? 'diskda' : m.downloading ? 'yuklanmoqda' : "yo'q"}</span></div>`;
  $('localModels').innerHTML = row(s.chat, 'chat') + row(s.embed, 'embed');
  $('localVectors').textContent = v.ready
    ? `${v.embedded} ta hujjat ${v.model} bilan indekslangan (${v.dim} o'lchov). Yangi hujjatlar avtomatik qo'shiladi.`
    : "Embedding modeli yuklanmagan — qidiruv faqat kalit so'zlar bo'yicha ishlaydi.";
  if (s.error) toast('Lokal model xatosi: ' + s.error, 'err', 6000);
};
$('localLoad').addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Yuklanmoqda…'; try { await api('/local/load', { method: 'POST' }); toast('Yuklandi', 'ok'); } catch (err) { toast(err.message, 'err'); } finally { e.target.disabled = false; e.target.textContent = 'Yuklash'; loaders.local(); } });
$('localUnload').addEventListener('click', async () => { await api('/local/unload', { method: 'POST' }); toast("Bo'shatildi", 'ok'); loaders.local(); });
$('localReindex').addEventListener('click', async (e) => { e.target.disabled = true; try { const r = await api('/local/reindex', { method: 'POST' }); toast(`${r.embedded} hujjat indekslandi`, 'ok'); } catch (err) { toast(err.message, 'err'); } finally { e.target.disabled = false; loaders.local(); } });

// ── boot ────────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function boot() {
  connectLogStream();
  const initial = (location.hash || '#dashboard').slice(1);
  go(document.getElementById('page-' + initial) ? initial : 'dashboard');

  // Keep the dashboard, training and telegram views fresh.
  setInterval(async () => {
    try {
      if (currentPage === 'dashboard') await loaders.dashboard();
      else {
        const s = await api('/status');
        const badge = $('escBadge');
        badge.hidden = !s.agent.openEscalations;
        badge.textContent = s.agent.openEscalations;
        if (currentPage === 'telegram') renderTelegram(s.telegram);
        if (currentPage === 'training' && s.training.running) renderTraining(await api('/training'));
      }
    } catch {
      /* transient */
    }
  }, 5000);
}

boot();
