/**
 * Vazifalar — one-off scheduled work and standing routines together.
 *
 * They were separate pages, but the question is the same one: what is the
 * agent going to do without me, and when. Splitting that across two screens
 * meant neither answered it.
 */
import { useCallback, useEffect, useState } from 'react';
import { FiCheck, FiClock, FiPlay, FiPlus, FiRefreshCw, FiRepeat, FiTrash2, FiX } from 'react-icons/fi';
import { api } from '../api/client';
import { Badge, Card, Empty, ErrorBox, PageHead } from '../components/Ui';
import { time } from '../utils/format';

const STATUS = {
  pending: ['navbatda', 'info'],
  running: ['bajarilmoqda', 'warn'],
  done: ['bajarildi', 'ok'],
  failed: ['xato', 'danger'],
  cancelled: ['bekor qilindi', ''],
};

const KIND = {
  send_message: 'Xabar yuborish',
  assistant_run: 'Koʻrsatma',
  create_bot: 'Bot yaratish',
};

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [routines, setRoutines] = useState([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ schedule: '', title: '', instruction: '' });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      const [t, r] = await Promise.all([
        api.get(`/tasks?status=${filter}`, { silent }),
        api.get('/routines', { silent }),
      ]);
      setTasks(t || []);
      setRoutines(r || []);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [filter]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const addRoutine = async () => {
    if (!form.instruction.trim() || !form.schedule.trim()) return;
    setAdding(true);
    try {
      await api.post('/routines', form);
      setForm({ schedule: '', title: '', instruction: '' });
      load();
    } catch (e) {
      setError(e);
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <PageHead title="Vazifalar" desc="Rejalashtirilgan ishlar va bir marta aytilib abadiy bajariladigan doimiy vazifalar">
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <Card title="Doimiy vazifa qoʻshish" icon={FiRepeat}>
        <div className="grid c2">
          <label className="field">
            <span>Vaqti</span>
            <input
              type="text"
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              placeholder="har kuni soat 9 da / har 2 soatda / har dushanba 10:00"
            />
          </label>
          <label className="field">
            <span>Nomi</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Ertalabki hisobot"
            />
          </label>
        </div>
        <label className="field">
          <span>Koʻrsatma</span>
          <textarea
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder="Barcha guruhlarni tekshirib, javobsiz qolgan savollar boʻlsa menga shaxsiy chatda hisobot ber"
          />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={addRoutine} disabled={adding}>
            <FiPlus size={14} /> Qoʻshish
          </button>
        </div>
      </Card>

      <Card title={`Doimiy vazifalar (${routines.length})`} icon={FiRepeat}>
        {routines.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nomi</th>
                  <th>Vaqti</th>
                  <th>Keyingi</th>
                  <th className="num">Bajarilgan</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {routines.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.title}</strong>
                      <div className="hint">{r.instruction}</div>
                    </td>
                    <td>
                      {r.schedule}
                      {!r.enabled && <Badge>toʻxtatilgan</Badge>}
                    </td>
                    <td>{r.nextRun || '—'}</td>
                    <td className="num">{r.runs || 0}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={async () => {
                            await api.post(`/routines/${r.id}/toggle`);
                            load();
                          }}
                        >
                          {r.enabled ? <FiX size={13} /> : <FiCheck size={13} />}
                        </button>
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={async () => {
                            if (!confirm('Doimiy vazifa oʻchirilsinmi?')) return;
                            await api.del(`/routines/${r.id}`);
                            load();
                          }}
                        >
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
          <Empty icon={FiRepeat}>
            Doimiy vazifa yoʻq. Telegramda ham aytishingiz mumkin: «har kuni soat 9 da guruhlarni tekshir»
          </Empty>
        )}
      </Card>

      <Card
        title="Rejalashtirilgan ishlar"
        icon={FiClock}
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Barchasi</option>
            <option value="pending">Navbatda</option>
            <option value="done">Bajarilgan</option>
            <option value="failed">Xato</option>
            <option value="cancelled">Bekor qilingan</option>
          </select>
        }
      >
        {tasks.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Holat</th>
                  <th>Vazifa</th>
                  <th>Vaqt</th>
                  <th>Natija</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const [label, tone] = STATUS[t.status] || [t.status, ''];
                  const result = t.status === 'done' ? t.result : t.error;
                  return (
                    <tr key={t.id}>
                      <td className="mono">{t.id}</td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                      </td>
                      <td>
                        <strong>{t.title || KIND[t.kind] || t.kind}</strong>
                        <div className="hint">{KIND[t.kind] || t.kind}</div>
                      </td>
                      <td>{time(t.run_at)}</td>
                      <td style={{ maxWidth: 300 }}>
                        <div className="hint">{String(result || '').replace(/[{}"]/g, '').slice(0, 140)}</div>
                      </td>
                      <td>
                        {t.status === 'pending' && (
                          <div className="row">
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={async () => {
                                await api.post(`/tasks/${t.id}/run`);
                                load();
                              }}
                            >
                              <FiPlay size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={async () => {
                                await api.post(`/tasks/${t.id}/cancel`);
                                load();
                              }}
                            >
                              <FiX size={13} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={FiClock}>Vazifa yoʻq</Empty>
        )}
      </Card>
    </>
  );
}
