import { useEffect, useRef, useState } from "react";
import { TbBolt, TbSend, TbTerminal2, TbTrash, TbUsers } from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { Badge, Card, Empty, ErrorBox, PageHead } from "../../components/ui";
import { ms, time } from "../../utils/format";

/**
 * Buyruq berish — agentga to'g'ridan-to'g'ri vazifa.
 *
 * Bu YOZISHMA EMAS, ijro: bu yerda yozilgan buyruq agentning haqiqiy
 * akkaunti bilan bajariladi — u xabar yubora oladi, guruh yaratadi,
 * kod yozadi. Shuning uchun javob bilan birga u QANDAY vositalarni
 * ishlatgani ham ko'rsatiladi: nima qilganini ko'rmasdan ishonish
 * mumkin emas.
 *
 * "Guruhda so'ralgandek" tugmasi — sinov rejimi. Guruhda so'ralgan
 * maxfiy ma'lumot (token, parol) guruhga tushmasligi, shaxsiy chatga
 * ketishi kerak; bu qoida aynan shu yerda tekshiriladi.
 */

/** Yozish oynasi ostidagi tayyor buyruqlar — nima yozish mumkinligini
 *  ko'rsatadi. Ular UMUMIY misollar, aniq buyruq emas. */
const EXAMPLES = [
  "Bugun kim yozdi va nima soʻradi — qisqacha xulosa qil",
  "Yangi loyiha boshla: oddiy statik sahifa, ishga tushirib koʻrsat",
  "Har kuni ertalab soat 9 da tunda kelgan savollarni menga yuborib tur",
];

export default function Assistant() {
  const [text, setText] = useState("");
  const [asGroup, setAsGroup] = useState(false);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const boxRef = useRef(null);

  // Yangi javob kelganda pastga suriladi — foydalanuvchi qo'lda
  // aylantirib o'tirmasin
  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: "smooth" });
  }, [runs]);

  const run = async () => {
    const instruction = text.trim();
    if (!instruction || busy) return;

    setBusy(true);
    setError(null);
    const startedAt = Date.now();

    // Buyruq darhol ro'yxatga tushadi — javob kutilayotgani ko'rinib
    // tursin, aks holda "bosdimmi yo'qmi?" degan savol tug'iladi.
    const id = startedAt;
    setRuns((prev) => [...prev, { id, instruction, asGroup, pending: true, at: startedAt }]);
    setText("");

    try {
      const out = await client.post(ENDPOINTS.ASSISTANT_RUN, {
        text: instruction,
        chatType: asGroup ? "group" : "private",
      });

      setRuns((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, pending: false, result: out, tookMs: Date.now() - startedAt } : r
        )
      );
    } catch (e) {
      setError(e);
      setRuns((prev) =>
        prev.map((r) => (r.id === id ? { ...r, pending: false, failed: true } : r))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead>
        <label className={styles.toggle}>
          <input type="checkbox" checked={asGroup} onChange={(e) => setAsGroup(e.target.checked)} />
          <TbUsers size={14} />
          Guruhda soʻralgandek
        </label>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setRuns([])}
          disabled={!runs.length}
        >
          <TbTrash size={14} /> Tozalash
        </button>
      </PageHead>

      <ErrorBox error={error} />

      <Card
        title="Buyruq va javob"
        icon={TbTerminal2}
        actions={busy ? <Badge tone="info" pulse>bajarilmoqda</Badge> : null}
      >
        <div className={styles.box} ref={boxRef}>
          {runs.length ? (
            runs.map((r) => (
              <div key={r.id} className={styles.run}>
                <div className={styles.ask}>
                  {r.asGroup && <Badge tone="warn">guruh</Badge>}
                  <span>{r.instruction}</span>
                  <span className={styles.askTime}>{time(r.at)}</span>
                </div>

                {r.pending && (
                  <div className={styles.pending}>
                    <span className={styles.dots} aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    Agent ishlamoqda…
                  </div>
                )}

                {r.failed && <div className={styles.failed}>Buyruq bajarilmadi</div>}

                {r.result && (
                  <div className={styles.answer}>
                    <div className={styles.answerText}>
                      {r.result.reply || r.result.text || "(javob boʻsh)"}
                    </div>

                    {/* Agent qanday vositalarni ishlatgani — javobning
                        o'zi emas, uning DALILI */}
                    {r.result.tools?.length > 0 && (
                      <div className={styles.tools}>
                        {r.result.tools.map((t, i) => (
                          <Badge key={i} tone="info">
                            {typeof t === "string" ? t : t.name}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className={styles.meta}>
                      {r.tookMs ? ms(r.tookMs) : null}
                      {r.result.model ? ` · ${r.result.model}` : ""}
                      {r.result.provider ? ` · ${r.result.provider}` : ""}
                    </div>
                  </div>
                )}
              </div>
            ))
          ) : (
            <Empty icon={TbBolt}>
              Buyruq yozing — agent uni haqiqiy akkaunti bilan bajaradi
            </Empty>
          )}
        </div>

        <div className={styles.composer}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            // Ctrl+Enter — yuborish. Oddiy Enter yangi qator qoldiradi:
            // ko'p qatorli buyruq bu yerda odatiy hol.
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
            }}
            rows={3}
            placeholder="Agentga nima qilish kerakligini yozing…"
          />
          <div className="row end">
            <span className="hint">Ctrl + Enter — yuborish</span>
            <button type="button" className="btn" onClick={run} disabled={busy || !text.trim()}>
              <TbSend size={14} /> Yuborish
            </button>
          </div>
        </div>

        <div className={styles.examples}>
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className={styles.example} onClick={() => setText(e)}>
              {e}
            </button>
          ))}
        </div>
      </Card>
    </>
  );
}
