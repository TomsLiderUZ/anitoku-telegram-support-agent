/**
 * Suhbatlar — the conversations the agent is handling, and the questions it
 * escalated because it could not answer them.
 *
 * Escalations sit on the same page because they are not a separate subject:
 * they are the conversations that need you.
 */
import { useCallback, useEffect, useState } from 'react';
import { FiAlertCircle, FiMessageSquare, FiRefreshCw, FiSend, FiTrash2 } from 'react-icons/fi';
import { api } from '../api/client';
import { Badge, Card, Empty, ErrorBox, Loading, PageHead } from '../components/Ui';
import { ago, time } from '../utils/format';
import styles from './Chats.module.css';

const STATE = {
  auto: ['Avtomatik', 'ok'],
  human: ['Operator', 'warn'],
  paused: ['Toʻxtatilgan', ''],
};

export default function Chats() {
  const [chats, setChats] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [sel, setSel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    try {
      const [c, e] = await Promise.all([
        api.get('/chats?limit=60', { silent }),
        api.get('/escalations?status=open', { silent }),
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
      setMessages(await api.get(`/chats/${chat.tg_chat_id}/messages?limit=60`));
    } catch (e) {
      setError(e);
    }
  };

  const send = async () => {
    if (!reply.trim() || !sel) return;
    try {
      await api.post(`/chats/${sel.tg_chat_id}/reply`, { text: reply });
      setReply('');
      open(sel);
    } catch (e) {
      setError(e);
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <PageHead title="Suhbatlar" desc="Agent yuritayotgan yozishmalar. Kerak boʻlsa oʻzingiz javob yozishingiz mumkin">
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <FiRefreshCw size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      {escalations.length > 0 && (
        <Card title={`Javob kutayotgan savollar (${escalations.length})`} icon={FiAlertCircle}>
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
              <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                <input
                  type="text"
                  value={answers[e.id] || ''}
                  onChange={(ev) => setAnswers({ ...answers, [e.id]: ev.target.value })}
                  placeholder="Javobingiz — agent uni foydalanuvchiga yetkazadi"
                />
                <button
                  type="button"
                  className="btn sm"
                  onClick={async () => {
                    const text = (answers[e.id] || '').trim();
                    if (!text) return;
                    await api.post(`/escalations/${e.id}/answer`, { answer: text });
                    setAnswers({ ...answers, [e.id]: '' });
                    load();
                  }}
                >
                  <FiSend size={13} /> Yuborish
                </button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className={styles.split}>
        <Card title="Chatlar" icon={FiMessageSquare}>
          <div className={styles.list}>
            {chats.length ? (
              chats.map((c) => {
                const [label, tone] = STATE[c.state] || [c.state, ''];
                return (
                  <button
                    key={c.tg_chat_id}
                    type="button"
                    className={`${styles.chat} ${sel?.tg_chat_id === c.tg_chat_id ? styles.chatOn : ''}`}
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
          title={sel ? sel.title || sel.tg_chat_id : 'Chat tanlang'}
          icon={FiMessageSquare}
          actions={
            sel && (
              <>
                <select
                  value={sel.state}
                  onChange={async (e) => {
                    await api.post(`/chats/${sel.tg_chat_id}/state`, { state: e.target.value });
                    setSel({ ...sel, state: e.target.value });
                    load(true);
                  }}
                  style={{ width: 'auto' }}
                >
                  <option value="auto">Avtomatik javob</option>
                  <option value="human">Operator</option>
                  <option value="paused">Toʻxtatilgan</option>
                </select>
                <button type="button" className="btn ghost sm" onClick={() => open(sel)}>
                  <FiRefreshCw size={13} />
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
                        {m.is_outgoing ? (m.is_agent ? 'Agent' : 'Siz') : m.sender_name || 'Foydalanuvchi'}
                        <span className={styles.msgTime}>{time(m.date)}</span>
                      </div>
                      <div className={styles.msgText}>{m.text || `[${m.media_type || 'media'}]`}</div>
                    </div>
                  ))
                ) : (
                  <Empty>Xabar yoʻq</Empty>
                )}
              </div>
              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send()}
                  placeholder="Oʻzingiz javob yozish…"
                />
                <button type="button" className="btn" onClick={send} disabled={!reply.trim()}>
                  <FiSend size={14} />
                </button>
              </div>
            </>
          ) : (
            <Empty icon={FiMessageSquare}>Chapdagi roʻyxatdan chat tanlang</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
