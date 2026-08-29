import { useCallback, useEffect, useState } from "react";
import {
  TbActivity,
  TbAlertTriangle,
  TbChartBar,
  TbCoin,
  TbMessage2,
  TbRefresh,
  TbServer,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { DonutChart, RankChart, TrendChart } from "../../components/charts";
import { Badge, Card, Empty, ErrorBox, Loading, PageHead, Stat } from "../../components/ui";
import { ago, compact, ms, num } from "../../utils/format";

/** Qaysi oraliqda ko'rish. Ko'proq variant kerak emas — bu uchtasi
 *  "hozir", "bugun" va "shu hafta" degan savollarni qoplaydi. */
const RANGES = [
  [6, "6 soat"],
  [24, "24 soat"],
  [168, "7 kun"],
];

export default function Dashboard() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(
    async (silent = false) => {
      try {
        setData(await client.get(ENDPOINTS.STATS(hours), { silent }));
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [hours]
  );

  useEffect(() => {
    load();
    // Fon yangilanishi `silent` — aks holda yuklanish chizig'i
    // har 30 soniyada miltillab turardi.
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data && !error) return <Loading rows={4} />;

  const s = data?.summary || {};
  const providers = (data?.providers || []).map((p) => ({ name: p.provider, value: p.calls }));
  const purposes = (data?.purposes || []).map((p) => ({ name: p.purpose, value: p.tokens }));
  const chats = (data?.topChats || []).map((c) => ({ name: c.title, value: c.messages }));
  const knowledge = (data?.knowledge || []).map((k) => ({ name: k.source, value: k.c }));

  return (
    <>
      <PageHead>
        <div className={styles.range} role="group" aria-label="Vaqt oraligʻi">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`${styles.rangeBtn} ${hours === value ? styles.rangeOn : ""}`}
              onClick={() => setHours(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      {/* ── Asosiy ko'rsatkichlar ─────────────────────────────── */}
      <div className="grid c4">
        <Stat
          label="Yozilgan javoblar"
          value={num(s.replies)}
          sub={`${num(s.incoming)} ta xabar keldi`}
          tone="ok"
          trend={s.trend?.replies}
        />
        <Stat
          label="AI chaqiruvlari"
          value={num(s.calls)}
          sub="model soʻralgan marta"
          tone="info"
          trend={s.trend?.calls}
        />
        <Stat
          label="Sarflangan token"
          value={compact(s.tokens)}
          sub="kirish va chiqish birga"
          tone="warn"
          trend={s.trend?.tokens}
        />
        <Stat label="Oʻrtacha javob vaqti" value={ms(s.avgMs)} sub="muvaffaqiyatli chaqiruvlar" />
      </div>

      {/* ── Vaqt bo'yicha ─────────────────────────────────────── */}
      <div className="grid c2">
        <Card title="Xabarlar oqimi" icon={TbMessage2}>
          {data?.traffic?.length ? (
            <TrendChart
              data={data.traffic}
              series={[
                { key: "incoming", name: "Kelgan" },
                { key: "replies", name: "Javob" },
              ]}
            />
          ) : (
            <Empty>Bu oraliqda xabar boʻlmagan</Empty>
          )}
        </Card>

        <Card title="Model chaqiruvlari" icon={TbActivity}>
          {data?.ai?.length ? (
            <TrendChart
              data={data.ai}
              series={[
                { key: "calls", name: "Chaqiruv" },
                { key: "failed", name: "Xato" },
              ]}
            />
          ) : (
            <Empty>Chaqiruv qayd etilmagan</Empty>
          )}
        </Card>
      </div>

      {/* ── Kim va nimaga sarflaydi ───────────────────────────── */}
      <div className="grid c2">
        <Card title="Yukni kim koʻtardi" icon={TbServer}>
          {providers.length ? <RankChart data={providers} /> : <Empty />}
        </Card>

        <Card title="Token qaysi ishga ketdi" icon={TbCoin}>
          {purposes.length ? <RankChart data={purposes} /> : <Empty />}
        </Card>
      </div>

      <div className="grid c2">
        <Card title="Eng band suhbatlar" icon={TbMessage2}>
          {chats.length ? <RankChart data={chats} /> : <Empty>Suhbat boʻlmagan</Empty>}
        </Card>

        <Card title="Bilim tarkibi" icon={TbChartBar}>
          {knowledge.length ? (
            <DonutChart
              data={knowledge}
              center={
                <>
                  <div className={styles.donutValue}>
                    {num(knowledge.reduce((sum, k) => sum + k.value, 0))}
                  </div>
                  <div className="hint">hujjat</div>
                </>
              }
            />
          ) : (
            <Empty>Bilim bazasi boʻsh</Empty>
          )}
        </Card>
      </div>

      {/* ── So'nggi xatolar ───────────────────────────────────── */}
      <Card
        title="Soʻnggi xatolar"
        icon={TbAlertTriangle}
        actions={
          data?.errors?.length ? (
            <Badge tone="danger">{data.errors.length}</Badge>
          ) : (
            <Badge tone="ok">toza</Badge>
          )
        }
      >
        {data?.errors?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vaqt</th>
                  <th>Provayder</th>
                  <th>Ish turi</th>
                  <th>Xabar</th>
                </tr>
              </thead>
              <tbody className="anim-stagger">
                {data.errors.map((e, i) => (
                  <tr key={i} style={{ "--i": i }}>
                    <td className="hint">{ago(e.created_at)}</td>
                    <td>{e.provider}</td>
                    <td className="mono">{e.purpose}</td>
                    <td className={styles.errorText}>{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Xato qayd etilmagan — hammasi joyida</Empty>
        )}
      </Card>
    </>
  );
}
