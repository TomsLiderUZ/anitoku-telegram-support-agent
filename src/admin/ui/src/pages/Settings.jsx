/**
 * Sozlamalar — Telegram connection, agent behaviour, and the live log.
 *
 * Telegram lives here because connecting the account is configuration you do
 * once; the log lives here because when a setting misbehaves the log is the
 * next place you look.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FiActivity, FiLink, FiLogOut, FiRefreshCw, FiSave, FiSettings, FiSmartphone } from 'react-icons/fi';
import { api, streamLogs } from '../api/client';
import { Badge, Card, Empty, ErrorBox, PageHead } from '../components/Ui';
import { time } from '../utils/format';
import styles from './Settings.module.css';

/** Only settings worth touching by hand; the rest are managed by the agent. */
const FIELDS = [
  ['auto_reply', 'Avtomatik javob', 'bool', 'Oʻchirilsa agent hech kimga javob bermaydi'],
  ['reply_to_private', 'Shaxsiy chatlarga javob', 'bool', ''],
  ['reply_in_groups', 'Guruhlarda javob', 'bool', 'Guruhda faqat mavzuga aloqador xabarlarga javob beradi'],
  ['keep_online', 'Doim online koʻrinish', 'bool', ''],
  ['typing_simulation', '"Yozmoqda" holati', 'bool', 'Javob tayyorlanayotganda koʻrsatiladi'],
  ['founder_private_replies', 'Javoblar faqat shaxsiy chatga', 'bool', 'Guruhda soʻralsa ham sizga shaxsiy yoziladi'],
  ['min_delay_ms', 'Eng kam kechikish (ms)', 'num', ''],
  ['max_delay_ms', 'Eng koʻp kechikish (ms)', 'num', ''],
  ['debounce_ms', 'Xabarlarni birlashtirish (ms)', 'num', 'Ketma-ket kelgan xabarlarni kutish vaqti'],
  ['max_replies_per_chat_hour', 'Bir chatga soatiga koʻpi bilan', 'num', ''],
  ['quiet_hours', 'Sukut soatlari', 'text', 'Masalan 01:00-07:00 — bu oraliqda javob bermaydi'],
  ['escalation_chat_id', 'Savollar yuboriladigan chat', 'text', 'Agent javob berolmagan savollar shu chatga tushadi'],
];

const LEVEL = { info: styles.info, warn: styles.warn, error: styles.error, debug: styles.debug };

export default function Settings() {
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [tg, setTg] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const qrPoll = useRef(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [s, t] = await Promise.all([api.get('/settings', { silent }), api.get('/telegram', { silent })]);
      setValues(s.values || {});
      setTg(t);
      if (t.phone && !phone) setPhone(t.phone);
      setError(null);
    } catch (e) {
      setError(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    api.get('/logs?limit=120', { silent: true }).then(setLogs).catch(() => {});
    return streamLogs((entry) => setLogs((l) => [...l.slice(-300), entry]));
  }, [load]);

  // While a QR is on screen it has to be refreshed: the token expires in ~30 s
  // and a dead code that still looks scannable is worse than none.
  const pollQr = useCallback(() => {
    clearInterval(qrPoll.current);
    qrPoll.current = setInterval(async () => {
      try {
        const s = await api.get('/telegram/qr', { silent: true });
        setQr(s);
        if (s.info) setTg(s.info);
        if (s.status !== 'awaiting_qr') {
          clearInterval(qrPoll.current);
          load(true);
        }
      } catch {
        clearInterval(qrPoll.current);
      }
    }, 3000);
  }, [load]);

  useEffect(() => () => clearInterval(qrPoll.current), []);

  const startQr = async () => {
    setError(null);
    try {
      const s = await api.post('/telegram/qr', {});
      setQr(s);
      pollQr();
    } catch (e) {
      setError(e);
    }
  };

  const save = async () => {
    if (!Object.keys(dirty).length) return;
    try {
      const r = await api.post('/settings', { values: dirty });
      setDirty({});
      setValues(r.values || values);
      if (r.ignored?.length) setError(new Error(`Qabul qilinmadi: ${r.ignored.join(', ')}`));
    } catch (e) {
      setError(e);
    }
  };

  const val = (k) => (k in dirty ? dirty[k] : values[k] ?? '');
  const connected = tg?.status === 'connected';

  return (
    <>
      <PageHead title="Sozlamalar" desc="Telegram ulanishi, agent xulqi va jonli jurnal">
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
        <button type="button" className="btn" onClick={save} disabled={!Object.keys(dirty).length}>
          <FiSave size={14} /> Saqlash
        </button>
      </PageHead>

      <ErrorBox error={error} />

      <Card
        title="Telegram akkaunt"
        icon={FiSmartphone}
        actions={
          <Badge tone={connected ? 'ok' : tg?.status === 'error' ? 'danger' : 'warn'} pulse={connected}>
            {connected ? `@${tg.username}` : tg?.status || '—'}
          </Badge>
        }
      >
        {connected ? (
          <div className="row">
            <div>
              <strong>{tg.firstName}</strong> · @{tg.username}
              <div className="hint">
                ID {tg.userId} · {tg.phone} · {tg.connectedAt ? time(tg.connectedAt) : ''}
              </div>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="btn danger sm"
              onClick={async () => {
                if (!confirm('Telegram akkaunt uzilsinmi?')) return;
                await api.post('/telegram/logout', {});
                load();
              }}
            >
              <FiLogOut size={13} /> Uzish
            </button>
          </div>
        ) : (
          <div className="grid c2">
            <div>
              <div className={styles.qr}>
                {qr?.svg ? (
                  <div dangerouslySetInnerHTML={{ __html: qr.svg }} />
                ) : (
                  <span className="hint" style={{ color: '#666' }}>
                    QR kodni olish uchun tugmani bosing
                  </span>
                )}
              </div>
              <div className={styles.qrNote}>
                {qr?.status === 'awaiting_qr' && !qr?.stale && (
                  <span className="hint">
                    Telefon → Sozlamalar → Qurilmalar → Kompyuterni ulash · {qr.expiresInSec}s ichida yangilanadi
                  </span>
                )}
                {qr?.stale && <Badge tone="warn">Kod eskirdi — yangilang</Badge>}
                {qr?.expired && <Badge tone="danger">Skanerlanmadi — qaytadan boshlang</Badge>}
              </div>
              <button type="button" className="btn block" style={{ marginTop: 'var(--sp-3)' }} onClick={startQr}>
                <FiLink size={14} /> {qr ? 'QR kodni yangilash' : 'QR kod bilan ulash'}
              </button>
            </div>

            <div>
              <div className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                QR ishlamasa telefon raqam bilan ulaning. API maʼlumotlari allaqachon saqlangan — ularga tegish shart emas.
              </div>
              <label className="field">
                <span>Telefon raqam</span>
                <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998901234567" autoComplete="off" />
              </label>
              <button
                type="button"
                className="btn ghost block"
                onClick={async () => {
                  try {
                    await api.post('/telegram/connect', { phone });
                    load();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Kod yuborish
              </button>

              {tg?.status === 'awaiting_code' && (
                <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                  <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Telegramdan kelgan kod" />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      await api.post('/telegram/code', { code });
                      setCode('');
                      load();
                    }}
                  >
                    Tasdiqlash
                  </button>
                </div>
              )}

              {tg?.status === 'awaiting_password' && (
                <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="2FA parol" />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      await api.post('/telegram/password', { password });
                      setPassword('');
                      load();
                    }}
                  >
                    Kirish
                  </button>
                </div>
              )}

              {tg?.lastError && <div className="hint" style={{ color: 'var(--danger)', marginTop: 'var(--sp-2)' }}>{tg.lastError}</div>}
            </div>
          </div>
        )}
      </Card>

      <Card title="Agent xulqi" icon={FiSettings}>
        <div className="grid c2">
          {FIELDS.map(([key, label, kind, hint]) => (
            <label key={key} className="field">
              <span>{label}</span>
              {kind === 'bool' ? (
                <select value={String(val(key)) === '1' ? '1' : '0'} onChange={(e) => setDirty({ ...dirty, [key]: e.target.value })}>
                  <option value="1">Yoqilgan</option>
                  <option value="0">Oʻchirilgan</option>
                </select>
              ) : (
                <input
                  type={kind === 'num' ? 'number' : 'text'}
                  value={val(key)}
                  onChange={(e) => setDirty({ ...dirty, [key]: e.target.value })}
                />
              )}
              {hint && <small>{hint}</small>}
            </label>
          ))}
        </div>
      </Card>

      <Card
        title="Jonli jurnal"
        icon={FiActivity}
        actions={
          <Badge tone="info" pulse>
            jonli
          </Badge>
        }
      >
        {logs.length ? (
          <div className={styles.logs} ref={(el) => el && (el.scrollTop = el.scrollHeight)}>
            {logs.slice(-300).map((l, i) => (
              <div key={i} className={`${styles.logLine} ${LEVEL[l.level] || ''}`}>
                <span className={styles.logTime}>{String(l.time || l.ts || '').slice(11, 19)}</span>
                <span className={styles.logTag}>{l.scope || l.tag || ''}</span>
                <span>{l.message || l.msg}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={FiActivity}>Jurnal boʻsh</Empty>
        )}
      </Card>
    </>
  );
}
