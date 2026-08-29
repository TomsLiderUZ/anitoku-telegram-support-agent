/**
 * Bilim va oʻqitish — what the agent knows, and the process that teaches it.
 *
 * The knowledge base, the learned skills, the generated personality and the
 * training run were four separate pages describing one loop. Together they
 * show cause and effect: train, and watch these numbers move.
 */
import { useCallback, useEffect, useState } from 'react';
import { FiBookOpen, FiCpu, FiPlay, FiPlus, FiRefreshCw, FiStar, FiTrash2, FiUser } from 'react-icons/fi';
import { api } from '../api/client';
import { DonutChart } from '../components/Charts';
import { Badge, Card, Empty, ErrorBox, Meter, PageHead, Stat } from '../components/Ui';
import { ago, num } from '../utils/format';
import styles from './Knowledge.module.css';

export default function Knowledge() {
  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState([]);
  const [skills, setSkills] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [tab, setTab] = useState('docs');
  const [q, setQ] = useState('');
  const [add, setAdd] = useState({ title: '', content: '' });
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [s, d, sk] = await Promise.all([
        api.get('/status', { silent }),
        api.get(`/knowledge?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`, { silent }),
        api.get('/skills', { silent }),
      ]);
      setStatus(s);
      setDocs(d.items || d || []);
      setSkills(sk || []);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'prompt') return;
    api
      .get('/prompts/preview/runtime')
      .then((r) => setPrompt(r.prompt || r.text || JSON.stringify(r, null, 2)))
      .catch((e) => setPrompt(e.message));
  }, [tab]);

  // While training runs, poll often enough that the progress bar actually moves.
  useEffect(() => {
    if (!status?.training?.running) return;
    const t = setInterval(() => load(true), 4000);
    return () => clearInterval(t);
  }, [status?.training?.running, load]);

  const training = status?.training || {};
  const kn = status?.knowledge || {};
  const bySource = (kn.bySource || []).map((s) => ({ name: s.source, value: s.c }));

  return (
    <>
      <PageHead title="Bilim va oʻqitish" desc="Agent nimalarni biladi va oʻzini qanday oʻqitadi">
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
        <button
          type="button"
          className="btn"
          disabled={training.running}
          onClick={async () => {
            await api.post('/training/run', {});
            load();
          }}
        >
          <FiPlay size={14} /> {training.running ? 'Oʻqitilmoqda…' : 'Oʻqitishni boshlash'}
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <div className="grid c4">
        <Stat label="Hujjatlar" value={num(kn.documents)} sub={`${num(kn.qaPairs)} savol-javob`} />
        <Stat label="Koʻnikmalar" value={num(status?.skills)} sub="oʻrganilgan qoidalar" tone="ok" />
        <Stat label="Shaxsiyat" value={`v${status?.prompt?.version ?? '—'}`} sub="joriy versiya" tone="info" />
        <Stat label="Oxirgi oʻqitish" value={training.lastAt ? ago(training.lastAt) : '—'} sub="avtomatik takrorlanadi" tone="warn" />
      </div>

      {training.running && (
        <Card title="Oʻqitish jarayoni" icon={FiCpu}>
          <Meter label={training.phase || 'boshlanmoqda'} value={training.progress || 0} max={100} right={`${training.progress || 0}%`} />
          {training.message && <div className="hint" style={{ marginTop: 'var(--sp-2)' }}>{training.message}</div>}
        </Card>
      )}

      <div className="grid c2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Bilim tarkibi" icon={FiBookOpen}>
          {bySource.length ? (
            <DonutChart
              data={bySource}
              center={
                <>
                  <div className={styles.big}>{num(kn.documents)}</div>
                  <div className="hint">hujjat</div>
                </>
              }
            />
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="Yangi fakt qoʻshish" icon={FiPlus}>
          <div className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
            Bu yerga qoʻshilgan maʼlumot mijozlarga javob berishda ishlatiladi.
          </div>
          <label className="field">
            <span>Sarlavha</span>
            <input type="text" value={add.title} onChange={(e) => setAdd({ ...add, title: e.target.value })} placeholder="Obuna narxlari" />
          </label>
          <label className="field">
            <span>Matn</span>
            <textarea value={add.content} onChange={(e) => setAdd({ ...add, content: e.target.value })} placeholder="ANITOKU hozircha butunlay bepul." />
          </label>
          <div className="row end">
            <button
              type="button"
              className="btn"
              disabled={!add.content.trim()}
              onClick={async () => {
                await api.post('/knowledge', add);
                setAdd({ title: '', content: '' });
                load();
              }}
            >
              <FiPlus size={14} /> Qoʻshish
            </button>
          </div>
        </Card>
      </div>

      <Card
        title={tab === 'docs' ? 'Bilim bazasi' : tab === 'skills' ? 'Koʻnikmalar' : 'Shaxsiyat'}
        icon={tab === 'skills' ? FiStar : tab === 'prompt' ? FiUser : FiBookOpen}
        actions={
          <>
            <div className={styles.tabs}>
              {[
                ['docs', 'Hujjatlar'],
                ['skills', 'Koʻnikmalar'],
                ['prompt', 'Shaxsiyat'],
              ].map(([id, label]) => (
                <button key={id} type="button" className={`${styles.tab} ${tab === id ? styles.tabOn : ''}`} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'docs' && (
              <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Qidirish…" style={{ width: 180 }} />
            )}
          </>
        }
      >
        {tab === 'docs' &&
          (docs.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sarlavha</th>
                    <th>Matn</th>
                    <th>Manba</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id}>
                      <td>{d.title || '—'}</td>
                      <td style={{ maxWidth: 460 }}>
                        <div className="hint">{String(d.content || '').slice(0, 200)}</div>
                      </td>
                      <td>
                        <Badge>{d.source}</Badge>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={async () => {
                            await api.del(`/knowledge/${d.id}`);
                            load();
                          }}
                        >
                          <FiTrash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Hujjat topilmadi</Empty>
          ))}

        {tab === 'skills' &&
          (skills.length ? (
            <div className={styles.skills}>
              {skills.map((s) => (
                <div key={s.slug} className={styles.skill}>
                  <div className="row">
                    <strong>{s.title || s.slug}</strong>
                    {!s.enabled && <Badge>oʻchiq</Badge>}
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn danger sm"
                      onClick={async () => {
                        await api.del(`/skills/${s.slug}`);
                        load();
                      }}
                    >
                      <FiTrash2 size={13} />
                    </button>
                  </div>
                  <div className="hint">{s.body || s.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Koʻnikma yoʻq</Empty>
          ))}

        {tab === 'prompt' && <pre className="block" style={{ maxHeight: 560 }}>{prompt || 'Yuklanmoqda…'}</pre>}
      </Card>
    </>
  );
}
