import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TbAlertCircle,
  TbArrowLeft,
  TbMessage2,
  TbRefresh,
  TbSearch,
  TbSend,
  TbX,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { Badge, Card, Empty, ErrorBox, Loading, PageHead } from "../../components/ui";
import { ago, time } from "../../utils/format";

/**
 * Suhbatlar — Telegram Desktop kabi ikki panel, panel dizaynida.
 *
 * Chapda roʻyxat, oʻngda yozishma, ikkalasi bitta kapsula ichida va
 * ekran balandligi boʻyicha. Ilgari ular ikkita alohida kartochka edi
 * va oʻng tomon deyarli boʻsh turardi — ekranning yarmi behuda ketardi,
 * yozishma esa kichkina darchaga tiqilib qolardi.
 *
 * MOBILDA — pastdan chiqadigan varaq EMAS. Chatga bosilsa roʻyxat
 * oʻrnini yozishma oladi, xuddi Telegramdagidek: oʻngdan surilib
 * kiradi, sarlavhada orqaga tugmasi. Pastdan chiqadigan varaq bu
 * yerda notoʻgʻri boʻlardi — bu vaqtinchalik oyna emas, siz kirgan
 * ikkinchi ekran.
 */

const STATE = {
  auto: ["Avtomatik", "ok"],
  human: ["Operator", "warn"],
  paused: ["Toʻxtatilgan", ""],
};

/** Ism yoki sarlavhadan ikki harfli belgi — avatar oʻrniga. */
function initials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Avatar rangi nomdan hosil qilinadi.
 *
 * Bir xil chat har doim bir xil rangda boʻladi, ya'ni roʻyxatni koʻz
 * bilan tez skanerlash mumkin — nomni oʻqimasdan ham "u yashil edi"
 * deb topiladi. Tasodifiy rang buni buzardi.
 */
const AVATAR_TONES = 6;
function toneOf(name) {
  let sum = 0;
  for (const ch of String(name || "")) sum = (sum + ch.charCodeAt(0)) % 997;
  return sum % AVATAR_TONES;
}

export default function Chats() {
  const [chats, setChats] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [sel, setSel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState("");
  const [answers, setAnswers] = useState({});
  const [q, setQ] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const feedRef = useRef(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [c, e] = await Promise.all([
        client.get(ENDPOINTS.CHATS(80), { silent }),
        client.get(ENDPOINTS.ESCALATIONS("open"), { silent }),
      ]);
      setChats(c || []);
      setEscalations(e || []);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  // Yangi xabar kelganda pastga tushamiz — yozishma oxiri koʻrinib tursin
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const openChat = async (chat) => {
    setSel(chat);
    setMessages([]);
    try {
      setMessages(await client.get(ENDPOINTS.CHAT_MESSAGES(chat.tg_chat_id, 80)));
    } catch (e) {
      setError(e);
    }
  };

  const send = async () => {
    const text = reply.trim();
    if (!text || !sel || sending) return;
    setSending(true);
    try {
      await client.post(ENDPOINTS.CHAT_REPLY(sel.tg_chat_id), { text });
      setReply("");
      setMessages(await client.get(ENDPOINTS.CHAT_MESSAGES(sel.tg_chat_id, 80)));
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter((c) =>
      `${c.title || ""} ${c.username || ""} ${c.tg_chat_id}`.toLowerCase().includes(needle)
    );
  }, [chats, q]);

  if (loading) return <Loading rows={4} />;

  return (
    <>
      <PageHead>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      {escalations.length > 0 && (
        <Card title={`Javob kutayotgan savollar (${escalations.length})`} icon={TbAlertCircle}>
          {escalations.map((e) => (
            <div key={e.id} className={styles.esc}>
              <div className="row">
                <Badge tone="warn">#{e.id}</Badge>
                <strong>{e.chat_title || e.tg_chat_id}</strong>
                <span className="spacer" />
                <span className="hint">{ago(e.created_at)}</span>
              </div>

              <p className={styles.escQ}>{e.question || e.summary}</p>
              {e.reason && <div className="hint">Sabab: {e.reason}</div>}

              <div className="row" style={{ marginTop: "var(--gap-8)" }}>
                <input
                  type="text"
                  value={answers[e.id] || ""}
                  onChange={(ev) => setAnswers({ ...answers, [e.id]: ev.target.value })}
                  placeholder="Javobingizni yozing — agent uni foydalanuvchiga yetkazadi"
                  className="grow"
                />
                <button
                  type="button"
                  className="btn sm"
                  onClick={async () => {
                    const text = (answers[e.id] || "").trim();
                    if (!text) return;
                    await client.post(ENDPOINTS.ESCALATION_ANSWER(e.id), { answer: text });
                    setAnswers({ ...answers, [e.id]: "" });
                    load();
                  }}
                >
                  <TbSend size={13} /> Yuborish
                </button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/*
        Bitta kapsula, ichida ikki panel. `data-open` — mobil uchun:
        chat tanlanganda roʻyxat chapga chiqib, yozishma oʻrnini oladi.
      */}
      <div className={styles.shell} data-open={sel ? "chat" : "list"}>
        {/* ── Chapdagi roʻyxat ──────────────────────────────────── */}
        <aside className={styles.list}>
          <div className={styles.listHead}>
            <label className={styles.search}>
              <TbSearch size={15} />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Qidirish…"
              />
              {q && (
                <button type="button" className={styles.clear} onClick={() => setQ("")} aria-label="Tozalash">
                  <TbX size={13} />
                </button>
              )}
            </label>
          </div>

          <div className={styles.listBody}>
            {filtered.length ? (
              filtered.map((c) => {
                const [label, tone] = STATE[c.state] || [c.state, ""];
                const active = sel?.tg_chat_id === c.tg_chat_id;
                return (
                  <button
                    key={c.tg_chat_id}
                    type="button"
                    className={`${styles.item} ${active ? styles.itemOn : ""}`}
                    onClick={() => openChat(c)}
                  >
                    <span className={styles.avatar} data-tone={toneOf(c.title || c.tg_chat_id)} aria-hidden="true">
                      {initials(c.title || c.tg_chat_id)}
                    </span>

                    <span className={styles.itemBody}>
                      <span className={styles.itemTop}>
                        <span className={styles.itemName}>{c.title || c.tg_chat_id}</span>
                        <span className={styles.itemTime}>{c.last_at ? time(c.last_at) : ""}</span>
                      </span>

                      <span className={styles.itemBottom}>
                        <span className={styles.itemPreview}>
                          {c.last_outgoing ? <em className={styles.you}>Siz: </em> : null}
                          {c.last_text || "—"}
                        </span>
                        {c.escalated ? (
                          <span className={styles.dot} title="Javob kutmoqda" />
                        ) : (
                          <span className={`${styles.state} ${styles[`state_${c.state}`]}`} title={label} />
                        )}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <Empty icon={TbMessage2}>{q ? "Topilmadi" : "Suhbat yoʻq"}</Empty>
            )}
          </div>
        </aside>

        {/* ── Oʻngdagi yozishma ─────────────────────────────────── */}
        <section className={styles.pane}>
          {sel ? (
            <>
              <header className={styles.paneHead}>
                {/* Faqat mobilda koʻrinadi — roʻyxatga qaytish */}
                <button
                  type="button"
                  className={styles.back}
                  onClick={() => setSel(null)}
                  aria-label="Roʻyxatga qaytish"
                >
                  <TbArrowLeft size={18} />
                </button>

                <span className={styles.avatar} data-tone={toneOf(sel.title || sel.tg_chat_id)} aria-hidden="true">
                  {initials(sel.title || sel.tg_chat_id)}
                </span>

                <span className={styles.paneTitle}>
                  <strong>{sel.title || sel.tg_chat_id}</strong>
                  <small>
                    {sel.type || "chat"} · {sel.replies_count || 0} javob
                    {sel.last_user_at ? ` · ${ago(sel.last_user_at)}` : ""}
                  </small>
                </span>

                <select
                  className={styles.stateSelect}
                  value={sel.state}
                  onChange={async (e) => {
                    await client.post(ENDPOINTS.CHAT_STATE(sel.tg_chat_id), { state: e.target.value });
                    setSel({ ...sel, state: e.target.value });
                    load(true);
                  }}
                >
                  <option value="auto">Avtomatik</option>
                  <option value="human">Operator</option>
                  <option value="paused">Toʻxtatilgan</option>
                </select>
              </header>

              <div className={styles.feed} ref={feedRef}>
                {messages.length ? (
                  messages.map((m, i) => {
                    const prev = messages[i - 1];
                    // Ketma-ket kelgan bir xil tomonli xabarlar guruhlanadi:
                    // har biriga ism yozilsa yozishma "kim-kim" bilan toʻlib
                    // ketadi va oʻqish qiyinlashadi.
                    const grouped = prev && !!prev.is_outgoing === !!m.is_outgoing && prev.is_agent === m.is_agent;
                    return (
                      <div
                        key={i}
                        className={`${styles.msg} ${m.is_outgoing ? styles.out : styles.in} ${grouped ? styles.grouped : ""}`}
                      >
                        {!grouped && (
                          <span className={styles.who}>
                            {m.is_outgoing ? (m.is_agent ? "Agent" : "Siz") : m.sender_name || "Foydalanuvchi"}
                          </span>
                        )}
                        <span className={styles.text}>{m.text || `[${m.media_type || "media"}]`}</span>
                        <span className={styles.stamp}>{time(m.date)}</span>
                      </div>
                    );
                  })
                ) : (
                  <Empty icon={TbMessage2}>Xabar yoʻq</Empty>
                )}
              </div>

              <footer className={styles.composer}>
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="Xabar yozing…"
                  className="grow"
                />
                <button
                  type="button"
                  className={styles.sendBtn}
                  onClick={send}
                  disabled={sending || !reply.trim()}
                  aria-label="Yuborish"
                >
                  <TbSend size={16} />
                </button>
              </footer>
            </>
          ) : (
            <div className={styles.blank}>
              <Empty icon={TbMessage2}>Chapdagi roʻyxatdan chat tanlang</Empty>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
