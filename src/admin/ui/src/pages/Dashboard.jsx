/**
 * Boshqaruv — what the agent has actually been doing.
 *
 * Everything here is a series or a breakdown rather than a bare counter: the
 * question worth answering on this page is "is it healthy and getting better
 * or worse", which a single number cannot answer.
 */
import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  FiAlertTriangle,
  FiBarChart2,
  FiClock,
  FiCpu,
  FiKey,
  FiMessageSquare,
  FiRefreshCw,
  FiZap,
} from 'react-icons/fi';
import { api } from '../api/client';
import { DonutChart, RankChart, TrendChart } from '../components/Charts';
import { Badge, Card, Empty, ErrorBox, Loading, Meter, PageHead, Stat } from '../components/Ui';
import { ago, compact, dur, ms, num } from '../utils/format';
import styles from './Dashboard.module.css';

const RANGES = [
  { h: 6, label: '6 soat' },
  { h: 24, label: '24 soat' },
  { h: 72, label: '3 kun' },
  { h: 168, label: '7 kun' },
];

export default function Dashboard() {
  const { status } = useOutletContext();
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = async (h = hours, silent = false) => {
    try {
      setData(await api.get(`/stats?hours=${h}`, { silent }));
      setError(null);
    } catch (e) {
      setError(e);
    }
  };

  useEffect(() => {
    load(hours);
    const t = setInterval(() => load(hours, true), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours]);

  const keyRows = useMemo(() => {
    const health = status?.keys || {};
    return Object.entries(health)
      .filter(([, v]) => v && typeof v === 'object' && v.total > 0)
      .map(([name, v]) => ({ name, ...v }));
  }, [status]);

  if (!data && !error) return <Loading label="Statistika yuklanmoqda…" />;

  const s = data?.summary || {};
  const providers = (data?.providers || []).map((p) => ({ ...p, name: p.provider }));
  const purposes = (data?.purposes || []).map((p) => ({ ...p, name: p.purpose }));
  const knowledge = (data?.knowledge || []).map((k) => ({ name: k.source, value: k.c }));
  const knowledgeTotal = knowledge.reduce((n, k) => n + k.value, 0);

  return (
    <>
      <PageHead title="Boshqaruv" desc="Agent nima qilayotgani, qancha resurs sarflayotgani va qayerda muammo borligi">
        <div className={styles.range}>
          {RANGES.map((r) => (
            <button
              key={r.h}
              type="button"
              className={`${styles.rangeBtn} ${hours === r.h ? styles.rangeOn : ''}`}
              onClick={() => setHours(r.h)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost sm" onClick={() => load(hours)}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load(hours)} />

      <div className="grid c4">
        <Stat label="Javoblar" value={num(s.replies)} trend={s.trend?.replies} sub={`${num(s.incoming)} ta kelgan xabar`} />
        <Stat label="AI chaqiruvlar" value={num(s.calls)} trend={s.trend?.calls} sub={`oʻrtacha ${ms(s.avgMs)}`} tone="info" />
        <Stat label="Tokenlar" value={compact(s.tokens)} trend={s.trend?.tokens} sub="24 soatda sarflangan" tone="warn" />
        <Stat
          label="Ish vaqti"
          value={dur(status?.agent?.uptimeSec || 0)}
          sub={`${num(status?.system?.rssMb)} MB xotira`}
          tone="ok"
        />
      </div>

      <div className="grid c2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Xabar oqimi" icon={FiMessageSquare}>
          <TrendChart
            data={data?.traffic || []}
            series={[
              { key: 'incoming', name: 'Kelgan' },
              { key: 'replies', name: 'Javoblar' },
            ]}
          />
        </Card>

        <Card title="AI yuklamasi" icon={FiZap}>
          <TrendChart
            data={data?.ai || []}
            series={[
              { key: 'calls', name: 'Chaqiruvlar' },
              { key: 'failed', name: 'Xatolar' },
            ]}
          />
        </Card>
      </div>

      <div className="grid c2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Provayderlar" icon={FiCpu}>
          {providers.length ? (
            <>
              <RankChart data={providers} dataKey="calls" height={Math.max(160, providers.length * 34)} />
              <div className="table-wrap" style={{ marginTop: 'var(--sp-3)' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Provayder</th>
                      <th className="num">Chaqiruv</th>
                      <th className="num">Xato</th>
                      <th className="num">Oʻrtacha</th>
                      <th className="num">Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => (
                      <tr key={p.provider}>
                        <td>{p.provider}</td>
                        <td className="num">{num(p.calls)}</td>
                        <td className="num">
                          {p.failed ? <span style={{ color: 'var(--danger)' }}>{num(p.failed)}</span> : '—'}
                        </td>
                        <td className="num">{ms(p.avgMs)}</td>
                        <td className="num">{compact(p.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <Empty>Bu davrda AI chaqiruvlari boʻlmagan</Empty>
          )}
        </Card>

        <Card title="Kalitlar holati" icon={FiKey}>
          {keyRows.length ? (
            keyRows.map((k) => (
              <Meter
                key={k.name}
                label={k.name}
                value={k.available}
                max={k.total}
                tone={k.available === 0 ? 'danger' : k.available < k.total / 3 ? 'warn' : 'ok'}
                right={
                  <>
                    {k.available}/{k.total}
                    {k.cooldown ? ` · ${k.cooldown} kutmoqda` : ''}
                    {k.disabled ? ` · ${k.disabled} oʻchiq` : ''}
                  </>
                }
              />
            ))
          ) : (
            <Empty>Kalit qoʻshilmagan</Empty>
          )}
        </Card>
      </div>

      <div className="grid c2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Ish turlari boʻyicha" icon={FiBarChart2}>
          {purposes.length ? (
            <RankChart data={purposes} dataKey="tokens" height={Math.max(160, purposes.length * 30)} />
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="Bilim bazasi" icon={FiBarChart2}>
          {knowledge.length ? (
            <DonutChart
              data={knowledge}
              center={
                <>
                  <div className={styles.donutNum}>{num(knowledgeTotal)}</div>
                  <div className={styles.donutLbl}>hujjat</div>
                </>
              }
            />
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      <div className="grid c2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Faol suhbatlar" icon={FiMessageSquare}>
          {data?.topChats?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Chat</th>
                    <th className="num">Xabar</th>
                    <th className="num">Javob</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topChats.map((c, i) => (
                    <tr key={i}>
                      <td>
                        {c.title}
                        {c.type && c.type !== 'private' && <Badge>{c.type}</Badge>}
                      </td>
                      <td className="num">{num(c.messages)}</td>
                      <td className="num">{num(c.replies)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Bu davrda suhbat boʻlmagan</Empty>
          )}
        </Card>

        <Card title="Soʻnggi xatolar" icon={FiAlertTriangle}>
          {data?.errors?.length ? (
            <div className={styles.errors}>
              {data.errors.map((e, i) => (
                <div key={i} className={styles.errRow}>
                  <div className={styles.errTop}>
                    <Badge tone="danger">{e.provider}</Badge>
                    <span className="hint">{e.purpose}</span>
                    <span className="spacer" />
                    <span className="hint">
                      <FiClock size={11} /> {ago(e.created_at)}
                    </span>
                  </div>
                  <div className={styles.errText}>{e.error}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Xato yoʻq — hammasi joyida</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
