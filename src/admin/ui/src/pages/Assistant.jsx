/**
 * Buyruq berish — the same channel the founder uses in Telegram, from a
 * browser. Every instruction here acts on the real account, so the page shows
 * exactly which tools ran rather than only the final sentence.
 */
import { useRef, useState } from 'react';
import { FiCornerDownLeft, FiSend, FiTool, FiUser } from 'react-icons/fi';
import { api } from '../api/client';
import { Card, ErrorBox, PageHead } from '../components/Ui';
import { ms } from '../utils/format';
import styles from './Assistant.module.css';

const EXAMPLES = [
  'Mirvohiddan botlarni tuzatib boʻlganini soʻra',
  'anitoku uchun anime sayt yasa',
  'har kuni soat 9 da guruhlarni tekshirib menga hisobot ber',
  'serverimga ulan: 206.189.157.53 root <parol> — disk holatini ayt',
];

export default function Assistant() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState(null);
  const boxRef = useRef(null);

  const send = async () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setBusy(true);
    setError(null);
    setText('');
    setTurns((t) => [...t, { role: 'user', text: instruction }]);

    try {
      const r = await api.post('/assistant/run', { text: instruction });
      setTurns((t) => [
        ...t,
        {
          role: 'agent',
          text: r.text || r.error || '(javob yoʻq)',
          privateText: r.privateText,
          meta: r.meta,
          ok: r.ok !== false,
        },
      ]);
    } catch (e) {
      setError(e);
      setTurns((t) => [...t, { role: 'agent', text: e.message, ok: false }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => boxRef.current?.scrollTo({ top: 1e6, behavior: 'smooth' }));
    }
  };

  return (
    <>
      <PageHead
        title="Buyruq berish"
        desc="Telegramda yozgandek — yordamchi akkaunt nomidan bajaradi: yozadi, soʻraydi, sayt va bot quradi, serverga ulanadi"
      />

      <ErrorBox error={error} />

      <Card>
        <div className={styles.thread} ref={boxRef}>
          {turns.length === 0 && (
            <div className={styles.examples}>
              <div className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
                Masalan:
              </div>
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className={styles.example} onClick={() => setText(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className={`${styles.turn} ${t.role === 'user' ? styles.user : styles.agent}`}>
              <div className={styles.who}>
                {t.role === 'user' ? <FiUser size={12} /> : <FiCornerDownLeft size={12} />}
                {t.role === 'user' ? 'Siz' : 'Yordamchi'}
              </div>
              <div className={`${styles.bubble} ${t.ok === false ? styles.failed : ''}`}>{t.text}</div>

              {t.privateText && (
                <div className={styles.privateNote}>
                  <strong>Shaxsiy chatga yuborildi:</strong> {t.privateText}
                </div>
              )}

              {t.meta && (
                <div className={styles.meta}>
                  {t.meta.toolsUsed?.length ? (
                    <span className={styles.tools}>
                      <FiTool size={11} />
                      {[...new Set(t.meta.toolsUsed)].join(', ')}
                    </span>
                  ) : (
                    <span className={styles.noTools}>vosita ishlatilmadi</span>
                  )}
                  <span className="spacer" />
                  {t.meta.model && <span>{t.meta.model}</span>}
                  {t.meta.latencyMs != null && <span>{ms(t.meta.latencyMs)}</span>}
                </div>
              )}
            </div>
          ))}

          {busy && <div className={styles.typing}>Bajarilmoqda…</div>}
        </div>

        <div className={styles.composer}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
            }}
            placeholder="Koʻrsatma yozing… (Ctrl+Enter — yuborish)"
            rows={3}
          />
          <button type="button" className="btn" onClick={send} disabled={busy || !text.trim()}>
            <FiSend size={14} /> Bajarish
          </button>
        </div>
        <div className="hint" style={{ marginTop: 'var(--sp-2)' }}>
          Bu haqiqiy akkaunt nomidan ishlaydi: «X ga yoz» desangiz, X haqiqatan xabar oladi.
        </div>
      </Card>
    </>
  );
}
