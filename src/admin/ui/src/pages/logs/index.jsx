import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TbArrowDown,
  TbFilter,
  TbFileAnalytics,
  TbPlayerPause,
  TbPlayerPlay,
  TbRefresh,
  TbSearch,
  TbTerminal2,
  TbX,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { streamLogs } from "../../api/logStream";
import { Badge, Card, Empty, ErrorBox, PageHead } from "../../components/ui";
import { ago, ms, num, time } from "../../utils/format";

/**
 * Jurnal — agentning butun ish tarixi va terminali.
 *
 * Ilgari jurnal Sozlamalar sahifasining pastida, tor kartochkada turardi:
 * xato qidirish uchun 40 ta qatorni teshikdan koʻrishga oʻxshardi. Endi
 * oʻz sahifasi bor, butun kenglikni egallaydi, VA filtrlanadi — chunki
 * "qaysidir joyda xato bor" degan holatda kerak boʻladigan yagona narsa
 * shu: darajani, boʻlimni yoki soʻzni tanlab, qolganini olib tashlash.
 *
 * ORALIQ: eng kam 1 soat, eng koʻp 7 kun. Xotiradagi halqa bir necha
 * daqiqani saqlaydi, undan naridagisi kunlik fayllardan oʻqiladi.
 */

/** Bittasi ham ortiqcha emas: "hozir", "bugun", "shu hafta". */
const RANGES = [
  [1, "1 soat"],
  [6, "6 soat"],
  [24, "24 soat"],
  [72, "3 kun"],
  [168, "7 kun"],
];

const LEVEL_CLASS = {
  trace: styles.trace,
  debug: styles.debug,
  info: styles.info,
  warn: styles.warn,
  error: styles.error,
  fatal: styles.fatal,
};

export default function Logs() {
  const [hours, setHours] = useState(1);
  const [level, setLevel] = useState("");
  const [scope, setScope] = useState("");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(true);

  const [result, setResult] = useState(null);
  const [facets, setFacets] = useState({ levels: [], scopes: [] });
  const [activity, setActivity] = useState(null);
  const [openCmd, setOpenCmd] = useState(null);
  const [error, setError] = useState(null);

  const boxRef = useRef(null);
  const pinnedRef = useRef(true); // pastga "yopishib" turibdimi

  const load = useCallback(
    async (silent = false) => {
      try {
        setResult(await client.get(ENDPOINTS.LOGS_SEARCH({ hours, level, scope, q, limit: 2000 }), { silent }));
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [hours, level, scope, q]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    client.get(ENDPOINTS.LOGS_FACETS, { silent: true }).then(setFacets).catch(() => {});
  }, []);

  // Terminal — agent hozir nima yozayotgani. Jurnaldan alohida soʻraladi,
  // chunki u tez oʻzgaradi va filtrlarga bogʻliq emas.
  useEffect(() => {
    const pull = () =>
      client.get(ENDPOINTS.ACTIVITY(80), { silent: true }).then(setActivity).catch(() => {});
    pull();
    const t = setInterval(pull, 5000);
    return () => clearInterval(t);
  }, []);

  /**
   * Jonli oqim.
   *
   * Faqat filtrga mos qatorlar qoʻshiladi — aks holda "faqat xatolar"
   * tanlangan ekranga sekundiga oʻnlab info qatori yogʻilardi.
   */
  useEffect(() => {
    if (!live) return;
    return streamLogs((entry) => {
      setResult((prev) => {
        if (!prev) return prev;
        if (level && LEVEL_ORDER[entry.level] < LEVEL_ORDER[level]) return prev;
        if (scope && !String(entry.scope || "").startsWith(scope)) return prev;
        if (q) {
          const hay = `${entry.scope} ${entry.msg} ${entry.meta ? JSON.stringify(entry.meta) : ""}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) return prev;
        }
        return { ...prev, total: prev.total + 1, items: [...prev.items.slice(-2000), entry] };
      });
    });
  }, [live, level, scope, q]);

  // Yangi qator kelganda pastga tushamiz — LEKIN faqat foydalanuvchi
  // allaqachon pastda tursa. Yuqoriga chiqib biror narsani oʻqiyotgan
  // boʻlsa, ekranni tortib olish eng bezovta qiladigan xatti-harakat.
  useEffect(() => {
    const el = boxRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [result]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const items = result?.items || [];
  const counts = useMemo(() => {
    const c = { warn: 0, error: 0 };
    for (const e of items) {
      if (e.level === "warn") c.warn++;
      if (e.level === "error" || e.level === "fatal") c.error++;
    }
    return c;
  }, [items]);

  const commands = activity?.commands || [];
  const filtersOn = Boolean(level || scope || q);

  return (
    <>
      <PageHead>
        <button
          type="button"
          className={`btn ${live ? "" : "ghost"} sm`}
          onClick={() => setLive((v) => !v)}
          title={live ? "Jonli oqimni toʻxtatish" : "Jonli oqimni yoqish"}
        >
          {live ? <TbPlayerPause size={14} /> : <TbPlayerPlay size={14} />}
          {live ? "Jonli" : "Toʻxtatilgan"}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      {/* ── Filtrlar ────────────────────────────────────────────── */}
      <Card
        title="Filtr"
        icon={TbFilter}
        actions={
          filtersOn && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setLevel("");
                setScope("");
                setQ("");
              }}
            >
              <TbX size={13} /> Tozalash
            </button>
          )
        }
      >
        <div className={styles.filters}>
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

          <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Daraja">
            <option value="">Barcha darajalar</option>
            {(facets.levels || []).map((l) => (
              <option key={l} value={l}>
                {l} va yuqori
              </option>
            ))}
          </select>

          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Boʻlim">
            <option value="">Barcha boʻlimlar</option>
            {(facets.scopes || []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <label className={styles.search}>
            <TbSearch size={15} />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Matn boʻyicha qidirish…"
            />
          </label>
        </div>

        <div className={styles.summary}>
          <span>
            {num(result?.total)} ta qator
            {result?.truncated ? ` · oxirgi ${num(items.length)} tasi koʻrsatilmoqda` : ""}
          </span>
          {counts.warn > 0 && <Badge tone="warn">{counts.warn} ogohlantirish</Badge>}
          {counts.error > 0 && <Badge tone="danger">{counts.error} xato</Badge>}
          <span className="spacer" />
          {!pinnedRef.current && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                pinnedRef.current = true;
                if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
              }}
            >
              <TbArrowDown size={13} /> Oxiriga
            </button>
          )}
        </div>
      </Card>

      {/* ── Jurnal ──────────────────────────────────────────────── */}
      <Card title="Jurnal" icon={TbFileAnalytics} actions={live ? <Badge tone="info" pulse>jonli</Badge> : null}>
        {items.length ? (
          <div className={styles.logs} ref={boxRef} onScroll={onScroll}>
            {items.map((l, i) => (
              <div key={`${l.ts}-${i}`} className={`${styles.line} ${LEVEL_CLASS[l.level] || ""}`}>
                <span className={styles.lineTime}>{fullTime(l.ts)}</span>
                <span className={styles.lineLevel}>{l.level}</span>
                <span className={styles.lineScope}>{l.scope}</span>
                <span className={styles.lineMsg}>
                  {l.msg}
                  {l.meta && <span className={styles.lineMeta}>{JSON.stringify(l.meta)}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            {filtersOn ? "Bu filtrga mos qator topilmadi" : "Bu oraliqda yozuv yoʻq"}
          </Empty>
        )}
      </Card>

      {/* ── Terminal ────────────────────────────────────────────── */}
      <Card
        title="Agent terminali"
        icon={TbTerminal2}
        actions={
          commands.length ? (
            <Badge tone={commands.some((c) => !c.ok) ? "warn" : "ok"}>
              {commands.length} buyruq
            </Badge>
          ) : null
        }
      >
        <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
          Agent terminalda nima yozayotgani. Buyruq ustiga bosing — javobini koʻrsatadi.
        </p>

        {commands.length ? (
          <div className={styles.terminal}>
            {commands
              .slice()
              .reverse()
              .map((c, i) => {
                const id = `${c.at}-${i}`;
                const open = openCmd === id;
                return (
                  <div key={id} className={`${styles.cmd} ${c.ok ? "" : styles.cmdBad}`}>
                    <button
                      type="button"
                      className={styles.cmdHead}
                      onClick={() => setOpenCmd(open ? null : id)}
                      aria-expanded={open}
                    >
                      <span className={styles.prompt} aria-hidden="true">
                        {c.target === "remote" ? `${c.host} $` : "$"}
                      </span>
                      <span className={styles.cmdText}>{c.command}</span>
                      <span className={styles.cmdMeta}>
                        {c.ok ? "" : `chiqish ${c.code} · `}
                        {ms(c.ms)} · {ago(c.at)}
                      </span>
                    </button>

                    {open && (
                      <div className={styles.cmdBody}>
                        <div className={styles.cmdWhere}>
                          {c.session} · {c.cwd}
                        </div>
                        <pre className={styles.cmdOut}>{c.output || "(javob boʻsh)"}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ) : (
          <Empty icon={TbTerminal2}>Agent hozircha terminalda hech narsa yozmagan</Empty>
        )}
      </Card>
    </>
  );
}

/** Daraja tartibi — jonli oqimni filtrlash uchun (backenddagi bilan bir xil). */
const LEVEL_ORDER = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** Jurnalda soat kerak, sana esa faqat boshqa kun boʻlsa. */
function fullTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(11, 19);
  const today = new Date().toDateString() === d.toDateString();
  const hhmmss = d.toLocaleTimeString("uz-UZ", { hour12: false });
  return today ? hhmmss : `${time(ts)} ${hhmmss}`;
}
