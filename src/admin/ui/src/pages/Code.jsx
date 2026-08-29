/**
 * Kod — the coding agent, run from the panel.
 *
 * It plans, reads, writes, runs and verifies on its own; the value of showing
 * the checklist afterwards is that you can see which steps it genuinely
 * completed rather than taking the summary on trust.
 */
import { useEffect, useState } from 'react';
import { FiCheckCircle, FiCircle, FiPlay, FiSlash, FiTerminal, FiXCircle } from 'react-icons/fi';
import { api } from '../api/client';
import { Badge, Card, ErrorBox, PageHead } from '../components/Ui';
import styles from './Code.module.css';

const ICON = {
  done: FiCheckCircle,
  in_progress: FiPlay,
  blocked: FiXCircle,
  skipped: FiSlash,
  pending: FiCircle,
};

export default function Code() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState('');
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get('/projects?all=1', { silent: true })
      .then((d) => setProjects(d.projects || []))
      .catch(() => {});
  }, [busy]);

  const run = async () => {
    if (!task.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = project
        ? await api.post(`/projects/${project}/task`, { task })
        : await api.post('/code/task', { task, name: name.trim() || null });
      setResult(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title="Kod"
        desc="Claude Code kabi ishlaydigan kod agenti: reja tuzadi, fayllarni oʻqiydi va yozadi, terminalda ishga tushirib tekshiradi, xatoni oʻzi tuzatadi"
      />

      <ErrorBox error={error} />

      <Card title="Yangi vazifa" icon={FiTerminal}>
        <div className="grid c2">
          <label className="field">
            <span>Loyiha</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">— sinov muhiti (vaqtinchalik) —</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name || p.slug}
                </option>
              ))}
            </select>
            <small>Loyiha tanlansa oʻzgarishlar doimiy saqlanadi; sinov muhiti tajriba uchun, panelda koʻrinmaydi</small>
          </label>
          <label className="field">
            <span>Sinov muhiti nomi</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="parser-sinov" disabled={!!project} />
          </label>
        </div>

        <label className="field">
          <span>Vazifa</span>
          <textarea
            rows={4}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Anime qidiruv API yoz: /search?q= soʻrovi Jikan'dan natija qaytarsin, xatolarni ushlasin, portni PORT muhit oʻzgaruvchisidan olsin. Yozib, ishga tushirib tekshir."
          />
        </label>

        <div className="row end">
          <button type="button" className="btn" onClick={run} disabled={busy || !task.trim()}>
            <FiPlay size={14} /> {busy ? 'Bajarilmoqda…' : 'Boshlash'}
          </button>
        </div>
      </Card>

      {(busy || result) && (
        <Card
          title="Natija"
          icon={FiTerminal}
          actions={
            result ? (
              <Badge tone={result.ok ? 'ok' : 'warn'}>{result.ok ? 'bajarildi' : "toʻliq emas"}</Badge>
            ) : (
              <Badge tone="info" pulse>
                ishlamoqda
              </Badge>
            )
          }
        >
          {busy && <div className="hint">Agent rejasini tuzmoqda — bu bir necha daqiqa olishi mumkin.</div>}

          {result && (
            <>
              <p>{result.summary}</p>

              {result.todos?.items?.length > 0 && (
                <div className={styles.todos}>
                  {result.todos.items.map((it, i) => {
                    const Icon = ICON[it.status] || FiCircle;
                    const cls = it.status === 'done' ? styles.done : it.status === 'in_progress' ? styles.doing : it.status === 'blocked' ? styles.blocked : '';
                    return (
                      <div key={i} className={`${styles.todo} ${cls}`}>
                        <Icon size={14} />
                        <span>
                          {it.text}
                          {it.note ? ` — ${it.note}` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <pre className={`block ${styles.out}`}>
                {[
                  `Oʻzgargan fayllar: ${(result.changed || []).join(', ') || '—'}`,
                  `Buyruqlar: ${(result.commands || []).slice(0, 15).join(' ; ') || '—'}`,
                  `Bosqichlar: ${result.rounds}`,
                  result.dir ? `Papka: ${result.dir}` : '',
                  result.mode ? `Rejim: ${result.mode === 'sandbox' ? 'sinov muhiti' : 'loyiha'}` : '',
                  result.logsTail ? `\n--- log ---\n${result.logsTail}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')}
              </pre>
            </>
          )}
        </Card>
      )}
    </>
  );
}
