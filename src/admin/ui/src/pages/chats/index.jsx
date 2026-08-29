import { useCallback, useEffect, useState } from "react";
import { TbAlertCircle, TbMessage2, TbRefresh, TbSend } from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { Badge, Card, Empty, ErrorBox, Loading, PageHead } from "../../components/ui";
import { ago, time } from "../../utils/format";

/**
 * Suhbatlar — agent yuritayotgan yozishmalar va u javob berolmay
 * sizga uzatgan savollar.
 *
 * Savollar aynan shu sahifada, chunki ular alohida mavzu emas: bu —
 * SIZNI kutayotgan suhbatlar. Ularni boshqa bo'limga ajratsak,
 * odam ikkita joyni navbatma-navbat tekshirib yurishi kerak bo'lardi.
 */

const STATE = {
  auto: ["Avtomatik", "ok"],
  human: ["Operator", "warn"],
  paused: ["Toʻxtatilgan", ""],
};

export default function Chats() {
  const [chats, setChats] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [sel, setSel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState("");
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    try {
      const [c, e] = await Promise.all([
        client.get(ENDPOINTS.CHATS(60), { silent }),
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

  const open = async (chat) => {
    setSel(chat);
    setMessages([]);
    try {
      setMessages(await client.get(ENDPOINTS.CHAT_MESSAGES(chat.tg_chat_id, 60)));
    } catch (e) {
      setError(e);
    }
  };

  const send = async () => {
    if (!reply.trim() || !sel) return;
    try {
      await client.post(ENDPOINTS.CHAT_REPLY(sel.tg_chat_id), { text: reply });
      setReply("");
      open(sel);
    } catch (e) {
      setError(e);
    }
  };

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

      <div className={styles.split}>
        <Card title="Chatlar" icon={TbMessage2}>
          <div className={`${styles.list} anim-stagger`}>
            {chats.length ? (
              chats.map((c, i) => {
                const [label, tone] = STATE[c.state] || [c.state, ""];
                return (
                  <button
                    key={c.tg_chat_id}
                    type="button"
                    style={{ "--i": i }}
                    className={`${styles.chat} ${sel?.tg_chat_id === c.tg_chat_id ? styles.chatOn : ""}`}
                    onClick={() => open(c)}
                  >
                    <div className="row">
                      <strong className={styles.chatTitle}>{c.title || c.tg_chat_id}</strong>
                      {c.escalated ? <Badge tone="warn">savol</Badge> : null}
                    </div>
                    <div className={styles.chatMeta}>
                      <Badge tone={tone}>{label}</Badge>
                      <span>{c.replies_count || 0} javob</span>
                      <span className="spacer" />
                      <span>{ago(c.last_user_at)}</span>
                    </div>
                  </button>
                );
              })
            ) : (
              <Empty>Suhbat yoʻq</Empty>
            )}
          </div>
        </Card>

        <Card
          title={sel ? sel.title || sel.tg_chat_id : "Chat tanlang"}
          icon={TbMessage2}
          actions={
            sel && (
              <>
                <select
                  value={sel.state}
                  onChange={async (e) => {
                    await client.post(ENDPOINTS.CHAT_STATE(sel.tg_chat_id), { state: e.target.value });
                    setSel({ ...sel, state: e.target.value });
                    load(true);
                  }}
                  style={{ width: "auto" }}
                >
                  <option value="auto">Avtomatik javob</option>
                  <option value="human">Operator</option>
                  <option value="paused">Toʻxtatilgan</option>
                </select>
                <button type="button" className="btn ghost sm" onClick={() => open(sel)}>
                  <TbRefresh size={13} />
                </button>
              </>
            )
          }
        >
          {sel ? (
            <>
              <div className={styles.messages}>
                {messages.length ? (
                  messages.map((m, i) => (
                    <div key={i} className={`${styles.msg} ${m.is_outgoing ? styles.out : styles.in}`}>
                      <div className={styles.msgWho}>
                        {m.is_outgoing ? (m.is_agent ? "Agent" : "Siz") : m.sender_name || "Foydalanuvchi"}
                        <span className={styles.msgTime}>{time(m.date)}</span>
                      </div>
                      <div className={styles.msgText}>{m.text || `[${m.media_type || "media"}]`}</div>
                    </div>
                  ))
                ) : (
                  <Empty>Xabar yoʻq</Empty>
                )}
              </div>

              <div className="row" style={{ marginTop: "var(--gap-12)" }}>
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="Oʻzingiz javob yozish…"
                  className="grow"
                />
                <button type="button" className="btn" onClick={send} disabled={!reply.trim()}>
                  <TbSend size={14} />
                </button>
              </div>
            </>
          ) : (
            <Empty icon={TbMessage2}>Chapdagi roʻyxatdan chat tanlang</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
