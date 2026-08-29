/**
 * AI modellar — cloud providers and the local models together.
 *
 * They were two pages, but the decision they support is one: which model
 * answers which kind of request, and is there capacity left. Seeing key health
 * next to local usage is what makes that decision obvious.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  FiCpu,
  FiDownload,
  FiHardDrive,
  FiKey,
  FiPlus,
  FiRefreshCw,
  FiTrash2,
  FiUploadCloud,
  FiZap,
} from 'react-icons/fi';
import { api } from '../api/client';
import { Badge, Card, Empty, ErrorBox, Meter, PageHead, Stat } from '../components/Ui';
import { ago, compact, dur, gb, ms, num } from '../utils/format';
import styles from './Models.module.css';

/** Jobs the local model may take. Anything a person reads defaults to cloud. */
const PURPOSES = [
  ['memory:summary', 'Suhbat xulosasi'],
  ['reply:retry', 'Javobni qayta urinish'],
  ['reply', 'Mijozlarga javob'],
  ['assistant', 'Sizning buyruqlaringiz'],
  ['coder', 'Kod yozish'],
  ['bot:code', 'Bot kodi'],
];

export default function Models() {
  const [keys, setKeys] = useState(null);
  const [local, setLocal] = useState(null);
  const [paste, setPaste] = useState('');
  const [provider, setProvider] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [k, l] = await Promise.all([api.get('/keys', { silent }), api.get('/local', { silent })]);
      setKeys(k);
      setLocal(l);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const setSetting = async (values) => {
    await api.post('/settings', { values });
    load();
  };

  const health = keys?.health || {};
  const providers = (keys?.providers || []).filter((p) => health[p.id]?.total > 0 || p.id === provider);
  const usage = local?.usage || {};
  const activePurposes = new Set(local?.purposes || []);

  return (
    <>
      <PageHead title="AI modellar" desc="Bulut provayderlar va shu kompyuterda ishlaydigan modellar">
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={async () => {
            await api.post('/keys/revive');
            load();
          }}
        >
          <FiZap size={14} /> Kalitlarni tiklash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <Card title="Kalitlar holati" icon={FiKey}>
        {providers.length ? (
          <div className={styles.keyGrid}>
            {providers.map((p) => {
              const h = health[p.id] || { total: 0, available: 0 };
              return (
                <div key={p.id} className={styles.provider}>
                  <div className={styles.providerTop}>
                    <span className={styles.providerName}>{p.label}</span>
                    {p.id === 'deepseek' || p.id === 'kimi' ? <span className={styles.paid}>pullik</span> : null}
                    <span className="spacer" />
                    {h.available === 0 && h.total > 0 && <Badge tone="danger">bandlik tugagan</Badge>}
                    {h.disabled > 0 && <Badge tone="warn">{h.disabled} oʻchiq</Badge>}
                    {p.signup && (
                      <a href={p.signup} target="_blank" rel="noreferrer" className="hint">
                        kalit olish →
                      </a>
                    )}
                  </div>
                  <Meter
                    label="Tayyor kalitlar"
                    value={h.available}
                    max={h.total}
                    tone={h.available === 0 ? 'danger' : h.available < h.total / 3 ? 'warn' : 'ok'}
                    right={`${h.available}/${h.total}${h.cooldown ? ` · ${h.cooldown} kutmoqda` : ''}`}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <Empty icon={FiKey}>Kalit qoʻshilmagan</Empty>
        )}
      </Card>

      <Card title="Kalit qoʻshish" icon={FiPlus}>
        <div className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
          Bir nechta kalitni birdaniga qoʻying — har qatorga bittadan. Provayder kalitning koʻrinishidan avtomatik aniqlanadi.
        </div>
        <label className="field">
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} placeholder={'gsk_…\nsk-or-v1-…\nAIza…'} />
        </label>
        <div className="row end">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Avtomatik aniqlash</option>
            {(keys?.providers || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={!paste.trim()}
            onClick={async () => {
              const r = await api.post('/keys', { keys: paste, provider: provider || undefined });
              setPaste('');
              load();
              if (r?.invalid) setError(new Error(`${r.invalid} ta kalit tanilmadi — provayderni qoʻlda tanlang`));
            }}
          >
            <FiPlus size={14} /> Qoʻshish
          </button>
        </div>
      </Card>

      {/* ── Local models ─────────────────────────────────────────────── */}
      <PageHead title="Lokal modellar" desc="Shu kompyuterda ishlaydi — bepul, lekin sekinroq. Fayl yoʻq boʻlsa bulut modellar ishlaydi" />

      <div className="grid c4">
        <Stat
          label="Chat modeli"
          value={local?.chat?.loaded ? 'Yuklangan' : local?.chat?.present ? 'Tayyor' : local?.chat?.downloading ? 'Yuklanmoqda' : "Yoʻq"}
          sub={local?.chat?.label}
          tone={local?.chat?.loaded ? 'ok' : ''}
        />
        <Stat label="Tezlatgich" value={String(local?.gpu || '—').toUpperCase()} sub={local?.contextSize ? `${num(local.contextSize)} token kontekst` : 'yuklanmagan'} tone="info" />
        <Stat label="Chaqiruvlar" value={num(usage.calls)} sub={`${usage.failed || 0} xato · RPM ${usage.rpm || 0}`} />
        <Stat label="Tezlik" value={ms(usage.avgMs)} sub={`eng uzun ${ms(usage.maxMs)}`} tone="warn" />
      </div>

      <div className="grid c2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Modellar" icon={FiHardDrive}>
          {['chat', 'code', 'embed'].map((kind) => {
            const m = local?.[kind];
            if (!m) return null;
            return (
              <div key={kind} className={styles.provider} style={{ marginBottom: 'var(--sp-3)' }}>
                <div className={styles.providerTop}>
                  <span className={styles.providerName}>{m.label}</span>
                  <span className="spacer" />
                  <Badge tone={m.loaded ? 'ok' : m.present ? 'info' : m.downloading ? 'warn' : ''}>
                    {m.loaded ? 'xotirada' : m.present ? 'diskda' : m.downloading ? 'yuklanmoqda' : "yoʻq"}
                  </Badge>
                </div>
                <div className="hint mono">
                  {m.file} · {m.sizeGb} GB{m.present ? ` · diskda ${gb(m.bytes)}` : m.downloading ? ` · ${gb(m.bytes)}` : ''}
                </div>
                {!m.present && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginTop: 'var(--sp-2)' }}
                    onClick={() => api.post(`/local/download/${kind}`).then(() => load())}
                  >
                    <FiDownload size={13} /> Yuklab olish
                  </button>
                )}
              </div>
            );
          })}
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <button type="button" className="btn ghost sm" onClick={() => api.post('/local/load').then(() => load())}>
              <FiUploadCloud size={13} /> Yuklash
            </button>
            <button type="button" className="btn ghost sm" onClick={() => api.post('/local/unload').then(() => load())}>
              <FiTrash2 size={13} /> Boʻshatish
            </button>
          </div>
        </Card>

        <Card title="Sozlash" icon={FiCpu}>
          <label className="field">
            <span>Tezlatgich</span>
            <select value={local?.backend || 'auto'} onChange={(e) => setSetting({ local_backend: e.target.value })}>
              <option value="auto">Avtomatik</option>
              <option value="vulkan">Vulkan (GPU)</option>
              <option value="cuda">CUDA (GPU)</option>
              <option value="cpu">Faqat CPU — sekin, lekin barqaror</option>
            </select>
            <small>Model yiqilaverса CPU'ga oʻtkazing; oʻzgarish keyingi yuklashda kuchga kiradi</small>
          </label>

          <label className="field">
            <span>Profil</span>
            <select value={local?.profile || 'auto'} onChange={(e) => setSetting({ local_profile: e.target.value })}>
              <option value="auto">Avtomatik ({local?.ramGb} GB RAM)</option>
              <option value="gpu">GPU — 7B modellar</option>
              <option value="cpu-small">Kichik server — 1B</option>
            </select>
          </label>

          <div className="field">
            <span>Qaysi ishlarni lokal model bajarsin</span>
            <div className={styles.purposeGrid}>
              {PURPOSES.map(([id, label]) => (
                <label key={id} className={styles.purpose}>
                  <input
                    type="checkbox"
                    checked={activePurposes.has(id)}
                    onChange={(e) => {
                      const next = new Set(activePurposes);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      setSetting({ local_purposes: [...next].join(',') });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            <small>Belgilanmaganlari bulut modellarga ketadi. Sizga javob berish va kod yozish uchun bulut tezroq va ishonchliroq.</small>
          </div>

          {usage.byPurpose?.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 'var(--sp-3)' }}>
              <table>
                <thead>
                  <tr>
                    <th>Ish turi</th>
                    <th className="num">Chaqiruv</th>
                    <th className="num">Oʻrtacha</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byPurpose.map((p) => (
                    <tr key={p.purpose}>
                      <td className="mono">{p.purpose}</td>
                      <td className="num">{num(p.calls)}</td>
                      <td className="num">{ms(p.avgMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="hint" style={{ marginTop: 'var(--sp-3)' }}>
            Ishlash vaqti: {usage.uptimeSec ? dur(usage.uptimeSec) : '—'}
            {usage.crashes ? ` · ${usage.crashes} marta yiqilgan` : ' · barqaror'}
            {usage.lastCrashAt ? ` (oxirgisi ${ago(usage.lastCrashAt)})` : ''}
            {usage.tokens24h ? ` · 24 soatda ${compact(usage.tokens24h)} token` : ''}
          </div>
        </Card>
      </div>
    </>
  );
}
