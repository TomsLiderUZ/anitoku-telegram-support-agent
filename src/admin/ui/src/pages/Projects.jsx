/**
 * Loyihalar — only what is actually deployed or running.
 *
 * Experiments live in the sandbox and never appear here; a bot created and
 * never started is not a project. Servers are shown read-only: the founder
 * connects one by pasting an IP and password into a chat, not by filling in a
 * form here.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  FiActivity,
  FiFileText,
  FiFolder,
  FiPlay,
  FiRefreshCw,
  FiServer,
  FiSquare,
  FiTrash2,
} from 'react-icons/fi';
import { api } from '../api/client';
import { Badge, Card, Empty, ErrorBox, PageHead } from '../components/Ui';
import { time } from '../utils/format';
import styles from './Projects.module.css';

const KIND = {
  node: 'Node.js',
  'telegram-bot': 'Telegram bot',
  web: 'Sayt',
  python: 'Python',
  static: 'Statik',
  other: 'Boshqa',
};

export default function Projects() {
  const [data, setData] = useState({ projects: [], servers: [] });
  const [showAll, setShowAll] = useState(false);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    try {
      setData(await api.get(`/projects${showAll ? '?all=1' : ''}`, { silent }));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [showAll]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (slug, what) => {
    try {
      if (what === 'delete') {
        if (!confirm(`"${slug}" fayllari bilan oʻchirilsinmi?`)) return;
        await api.del(`/projects/${slug}`);
        if (sel === slug) setSel(null);
      } else {
        await api.post(`/projects/${slug}/${what}`);
      }
      load();
    } catch (e) {
      setError(e);
    }
  };

  const show = async (slug, what) => {
    setSel(slug);
    setDetail('Yuklanmoqda…');
    try {
      const r = what === 'logs' ? await api.get(`/projects/${slug}/logs?lines=200`) : await api.get(`/projects/${slug}/files`);
      setDetail(
        what === 'logs'
          ? r.logs || '(log boʻsh)'
          : (r.files || []).map((f) => `${f.path}${f.size !== undefined ? `  ${f.size} B` : ''}`).join('\n') || '(fayl yoʻq)'
      );
    } catch (e) {
      setDetail(e.message);
    }
  };

  return (
    <>
      <PageHead
        title="Loyihalar"
        desc="Ishlab turgan va deploy qilingan dasturlar. Sinov va tajribalar alohida emulyatsiya muhitida bajariladi va bu yerda koʻrinmaydi"
      >
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} style={{ width: 'auto' }} />
          <span className="hint">Sinovlarni ham koʻrsat</span>
        </label>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <Card title="Dasturlar" icon={FiFolder}>
        {data.projects?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Loyiha</th>
                  <th>Turi</th>
                  <th>Holat</th>
                  <th>Buyruq</th>
                  <th className="num">Fayl</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.slug}>
                    <td>
                      <strong>{p.name || p.slug}</strong>
                      <div className="hint mono">{p.slug}</div>
                    </td>
                    <td>{KIND[p.kind] || p.kind}</td>
                    <td>
                      {p.alive ? (
                        <Badge tone="ok" pulse>
                          ishlayapti
                        </Badge>
                      ) : p.status === 'crashed' ? (
                        <Badge tone="danger">yiqilgan</Badge>
                      ) : (
                        <Badge>toʻxtagan</Badge>
                      )}
                      {p.last_error && <div className="hint">{p.last_error}</div>}
                    </td>
                    <td className="mono">{p.run_cmd || '—'}</td>
                    <td className="num">{p.files || 0}</td>
                    <td>
                      <div className="row">
                        <button type="button" className="btn ghost sm" onClick={() => show(p.slug, 'files')} title="Fayllar">
                          <FiFileText size={13} />
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => show(p.slug, 'logs')} title="Log">
                          <FiActivity size={13} />
                        </button>
                        {p.alive ? (
                          <button type="button" className="btn ghost sm" onClick={() => act(p.slug, 'stop')} title="Toʻxtatish">
                            <FiSquare size={13} />
                          </button>
                        ) : (
                          p.run_cmd && (
                            <button type="button" className="btn ok sm" onClick={() => act(p.slug, 'start')} title="Ishga tushirish">
                              <FiPlay size={13} />
                            </button>
                          )
                        )}
                        <button type="button" className="btn danger sm" onClick={() => act(p.slug, 'delete')}>
                          <FiTrash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={FiFolder}>
            Hali loyiha yoʻq. «Buyruq berish» boʻlimida: «anitoku uchun anime sayt yasa»
          </Empty>
        )}
      </Card>

      {sel && (
        <Card title={sel} icon={FiFileText} actions={<button type="button" className="btn ghost sm" onClick={() => setSel(null)}>Yopish</button>}>
          <pre className="block" style={{ maxHeight: 460 }}>
            {detail}
          </pre>
        </Card>
      )}

      <Card title="Ulangan serverlar" icon={FiServer}>
        <div className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
          Serverni bu yerdan qoʻshish shart emas — Telegramda agentga IP va parolni yozsangiz, oʻzi ulanadi va kalitini
          oʻrnatib oladi.
        </div>
        {data.servers?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nomi</th>
                  <th>Manzil</th>
                  <th>Kalit</th>
                  <th>Oxirgi ulanish</th>
                </tr>
              </thead>
              <tbody>
                {data.servers.map((s) => (
                  <tr key={s.name}>
                    <td>
                      <strong>{s.name}</strong>
                      {s.note && <div className="hint">{s.note}</div>}
                    </td>
                    <td className="mono">
                      {s.user}@{s.host}:{s.port}
                    </td>
                    <td>{s.key_installed ? <Badge tone="ok">oʻrnatilgan</Badge> : <Badge>parol bilan</Badge>}</td>
                    <td>
                      {s.last_ok ? time(s.last_ok) : '—'}
                      {s.last_error && <div className={styles.err}>{String(s.last_error).slice(0, 90)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={FiServer}>Server ulanmagan</Empty>
        )}
      </Card>
    </>
  );
}
