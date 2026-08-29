import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TbAlertCircle,
  TbArrowLeft,
  TbAt,
  TbCheck,
  TbClock,
  TbCopy,
  TbFileDescription,
  TbHash,
  TbInfoCircle,
  TbLink,
  TbMessage2,
  TbPhone,
  TbRefresh,
  TbSearch,
  TbSend,
  TbShieldCheck,
  TbUsers,
  TbX,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead } from "../../components/ui";
import { ago, num, time } from "../../utils/format";
import { linkify } from "../../utils/linkify";
import { useIsNarrowLayout } from "../../utils/useMediaQuery";

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

  // Yozishma ichidagi qidiruv — chat roʻyxati qidiruvidan alohida
  const [msgQuery, setMsgQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  // Chat maʼlumotlari va aʼzolar — faqat soʻralganda yuklanadi
  const [info, setInfo] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoLoading, setInfoLoading] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");

  const feedRef = useRef(null);

  /**
   * Telefonda ikki panel BIR VAQTDA turmaydi — biri ikkinchisining
   * o'rnini oladi.
   *
   * Ilgari ikkalasi ham chizilib, biri CSS bilan chetga surilardi.
   * Lekin ko'rinmas panel ham DOM da qolgani uchun ikkalasi bir-birining
   * ustiga tushib, ro'yxat qatorlari xabarlar orasidan ko'rinib turardi.
   * Endi qaysi biri kerak bo'lsa, faqat o'sha chiziladi.
   */
  const narrow = useIsNarrowLayout();
  const showList = !narrow || !sel;
  const showPane = !narrow || Boolean(sel);

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
    // Boshqa chatga oʻtganda qidiruv va maʼlumot oynasi tozalanadi —
    // oldingi chatning aʼzolari yangisinikidek koʻrinib qolmasin.
    setMsgQuery("");
    setSearchOpen(false);
    setInfo(null);
    try {
      setMessages(await client.get(ENDPOINTS.CHAT_MESSAGES(chat.tg_chat_id, 80)));
    } catch (e) {
      setError(e);
    }
  };

  /**
   * Chat maʼlumotlari — Telegramdan, bizning bazadan emas.
   *
   * Bazamiz faqat YOZGAN odamlarni biladi. "Bu guruhda kimlar bor"
   * degan savolga u notoʻgʻri javob berardi: jim turgan aʼzo umuman
   * koʻrinmasdi. Shuning uchun soʻrov Telegramning oʻziga boradi va
   * u sekinroq — aynan shu sababdan faqat soʻralganda yuklanadi.
   */
  const openInfo = async () => {
    if (!sel) return;
    setInfoOpen(true);
    setMemberQuery("");
    if (info) return; // shu chat uchun allaqachon olingan
    setInfoLoading(true);
    try {
      setInfo(await client.get(ENDPOINTS.CHAT_INFO(sel.tg_chat_id)));
    } catch (e) {
      setInfo({ info: { error: e.message } });
    } finally {
      setInfoLoading(false);
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

  // Yozishma ichidagi qidiruv — matn ham, yozgan odam ham hisobga olinadi
  const shownMessages = useMemo(() => {
    const needle = msgQuery.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((m) =>
      `${m.text || ""} ${m.sender_name || ""}`.toLowerCase().includes(needle)
    );
  }, [messages, msgQuery]);

  const members = info?.members?.members || [];
  const shownMembers = useMemo(() => {
    const needle = memberQuery.trim().toLowerCase();
    if (!needle) return members;
    return members.filter((m) =>
      `${m.name || ""} ${m.username || ""} ${m.id}`.toLowerCase().includes(needle)
    );
  }, [members, memberQuery]);

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

              <p className={styles.escQ}>{linkify(e.question || e.summary)}</p>
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

      {/* Bitta kapsula, ichida panellar. Keng ekranda ikkalasi yonma-yon;
          torida faqat bittasi chiziladi — qaysi biri kerak boʻlsa oʻsha. */}
      <div className={styles.shell}>
        {/* ── Chapdagi roʻyxat ──────────────────────────────────── */}
        {showList && (
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
        )}

        {/* ── Oʻngdagi yozishma ─────────────────────────────────── */}
        {showPane && (
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

                <button
                  type="button"
                  className={`${styles.headBtn} ${searchOpen ? styles.headBtnOn : ""}`}
                  onClick={() => {
                    setSearchOpen((v) => !v);
                    if (searchOpen) setMsgQuery("");
                  }}
                  aria-label="Yozishma ichidan qidirish"
                  title="Yozishma ichidan qidirish"
                >
                  <TbSearch size={16} />
                </button>

                <button
                  type="button"
                  className={styles.headBtn}
                  onClick={openInfo}
                  aria-label="Chat maʼlumotlari"
                  title="Chat maʼlumotlari"
                >
                  <TbInfoCircle size={16} />
                </button>

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

              {searchOpen && (
                <div className={styles.msgSearch}>
                  <TbSearch size={15} />
                  <input
                    type="search"
                    value={msgQuery}
                    onChange={(e) => setMsgQuery(e.target.value)}
                    placeholder="Shu yozishma ichidan qidirish…"
                    autoFocus
                  />
                  <span className="hint">
                    {msgQuery ? `${num(shownMessages.length)} ta topildi` : `${num(messages.length)} ta xabar`}
                  </span>
                  <button
                    type="button"
                    className={styles.headBtn}
                    onClick={() => {
                      setSearchOpen(false);
                      setMsgQuery("");
                    }}
                    aria-label="Yopish"
                  >
                    <TbX size={15} />
                  </button>
                </div>
              )}

              <div className={styles.feed} ref={feedRef}>
                {shownMessages.length ? (
                  shownMessages.map((m, i) => {
                    const prev = shownMessages[i - 1];
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
                        <span className={styles.text}>{m.text ? linkify(m.text) : `[${m.media_type || "media"}]`}</span>
                        <span className={styles.stamp}>{time(m.date)}</span>
                      </div>
                    );
                  })
                ) : (
                  <Empty icon={TbMessage2}>{msgQuery ? "Bu soʻz boʻyicha topilmadi" : "Xabar yoʻq"}</Empty>
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
        )}
      </div>

      {/* ── Chat maʼlumotlari va aʼzolar ───────────────────────── */}
      <Modal
        open={infoOpen}
        title={sel ? sel.title || String(sel.tg_chat_id) : "Chat"}
        onClose={() => setInfoOpen(false)}
      >
        {infoLoading && <Loading rows={3} />}

        {!infoLoading && info?.info?.error && (
          <ErrorBox error={{ message: info.info.error }} />
        )}

        {!infoLoading && info?.info && !info.info.error && (
          <>
            {/* Telegramdagi kabi: katta avatar markazda, ostida nom va
                bitta qatorlik xulosa — "16 aʼzo, 2 onlayn". */}
            <div className={styles.hero}>
              <span
                className={`${styles.avatar} ${styles.avatarXl}`}
                data-tone={toneOf(info.info.title || sel?.tg_chat_id)}
                aria-hidden="true"
              >
                {initials(info.info.title || sel?.tg_chat_id)}
              </span>
              <h3 className={styles.heroName}>{info.info.title || "—"}</h3>
              <p className={styles.heroSub}>{subtitleOf(info.info)}</p>
            </div>

            {/* Har bir qator: chapda belgi, oʻngda qiymat va uning ostida
                nima ekani. Qiymat tepada — koʻz avval unga tushadi. */}
            <div className={styles.rows}>
              <InfoRow
                icon={TbAt}
                label="Username"
                value={info.info.username ? `@${info.info.username}` : null}
                href={info.info.link}
                copy={info.info.username ? `@${info.info.username}` : null}
              />
              <InfoRow
                icon={TbPhone}
                label="Telefon"
                value={info.info.phone ? `+${String(info.info.phone).replace(/^\+/, "")}` : null}
                copy={info.info.phone}
              />
              <InfoRow icon={TbFileDescription} label="Tavsif" value={info.info.about} wrap />
              <InfoRow
                icon={TbLink}
                label="Taklif havolasi"
                value={info.info.inviteLink}
                href={info.info.inviteLink}
                copy={info.info.inviteLink}
              />
              <InfoRow
                icon={TbShieldCheck}
                label="Mening huquqlarim"
                value={
                  info.info.iAmCreator
                    ? "Yaratuvchi"
                    : info.info.myAdminRights?.length
                      ? info.info.myAdminRights.join(", ")
                      : null
                }
                wrap
              />
              <InfoRow icon={TbHash} label="Chat ID" value={info.info.id} copy={info.info.id} mono />
              <InfoRow
                icon={TbMessage2}
                label="Agent yozgan javoblar"
                value={sel?.replies_count ? num(sel.replies_count) : null}
              />
              <InfoRow
                icon={TbClock}
                label="Oxirgi xabar"
                value={sel?.last_at ? ago(sel.last_at) : null}
              />
            </div>

            {/* ── Aʼzolar ────────────────────────────────────── */}
            {info.members?.error && (
              <p className={styles.membersError}>
                Aʼzolar roʻyxati olinmadi: {info.members.error}
              </p>
            )}

            {members.length > 0 && (
              <div className={styles.membersBox}>
                <div className={styles.membersHead}>
                  <TbUsers size={16} />
                  <strong>{num(members.length)} aʼzo</strong>
                  <span className="spacer" />
                  <input
                    type="search"
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder="Qidirish…"
                    className={styles.memberSearch}
                  />
                </div>

                <div className={styles.members}>
                  {shownMembers.length ? (
                    shownMembers.map((m) => (
                      <div key={m.id} className={styles.member}>
                        <span className={styles.avatar} data-tone={toneOf(m.name || m.id)} aria-hidden="true">
                          {initials(m.name || m.username || "?")}
                        </span>

                        <span className={styles.memberBody}>
                          <span className={styles.memberName}>{m.name || m.username || m.id}</span>
                          <span className={styles.memberSub}>
                            {m.username ? `@${m.username}` : `ID ${m.id}`}
                          </span>
                        </span>

                        {/* Rol oʻngda — Telegramda ham shunday, va
                            "member" yozilmaydi: u sukut boʻyicha holat. */}
                        {m.bot && <Badge>bot</Badge>}
                        {m.role !== "member" && (
                          <Badge tone={m.role === "creator" ? "ok" : "info"}>
                            {m.role === "creator" ? "yaratuvchi" : m.rank || "admin"}
                          </Badge>
                        )}
                      </div>
                    ))
                  ) : (
                    <Empty icon={TbUsers}>Topilmadi</Empty>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}

/** Chat turi — texnik nom emas, odam o'qiydigan so'z. */
const KIND_LABEL = { user: "shaxsiy chat", group: "guruh", channel: "kanal" };

/**
 * Avatar ostidagi bitta qator: "16 aʼzo, 2 onlayn" yoki "shaxsiy chat".
 *
 * Telegramda aynan shu joyda eng muhim son turadi — guruh qanchalik
 * katta, nechtasi hozir shu yerda. Shaxsiy chatda esa bunday son yoʻq,
 * shuning uchun u yerda turi yoziladi.
 */
function subtitleOf(info) {
  if (info.kind === "user") return info.bot ? "bot" : "shaxsiy chat";
  const parts = [];
  if (info.members) parts.push(`${num(info.members)} aʼzo`);
  if (info.online) parts.push(`${num(info.online)} onlayn`);
  if (!parts.length) parts.push(KIND_LABEL[info.kind] || info.kind);
  return parts.join(", ");
}

/**
 * Ma'lumot qatori: belgi, qiymat, uning ostida nima ekani.
 *
 * Qiymati yo'q bo'lsa qator UMUMAN chizilmaydi. "Telefon: —" hech
 * narsa aytmaydi, faqat joy egallaydi va ko'zni chalg'itadi.
 */
function InfoRow({ icon: Icon, label, value, href, copy, mono = false, wrap = false }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(String(copy));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard https siz yoki ruxsatsiz ishlamaydi — tugma
      // shunchaki hech narsa qilmaydi, xato koʻrsatilmaydi.
    }
  };

  return (
    <div className={styles.row}>
      <Icon size={19} className={styles.rowIcon} />

      <div className={styles.rowBody}>
        <div className={`${styles.rowValue} ${mono ? "mono" : ""} ${wrap ? styles.rowWrap : ""}`}>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="link">
              {value}
            </a>
          ) : wrap ? (
            linkify(value)
          ) : (
            value
          )}
        </div>
        <div className={styles.rowLabel}>{label}</div>
      </div>

      {copy && (
        <button
          type="button"
          className={styles.copyBtn}
          onClick={onCopy}
          aria-label="Nusxa olish"
          title="Nusxa olish"
        >
          {copied ? <TbCheck size={15} /> : <TbCopy size={15} />}
        </button>
      )}
    </div>
  );
}
