import { useCallback, useEffect, useState } from "react";
import {
  TbBook2,
  TbCpu,
  TbPlayerPlay,
  TbPlus,
  TbRefresh,
  TbStar,
  TbTrash,
  TbUser,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { DonutChart } from "../../components/charts";
import { Badge, Card, Empty, ErrorBox, Meter, PageHead, Stat } from "../../components/ui";
import { ago, num } from "../../utils/format";

/**
 * Bilim va oʻqitish.
 *
 * Bilim bazasi, oʻrganilgan koʻnikmalar, yaratilgan shaxsiyat va
 * oʻqitish jarayoni — toʻrtta sahifa bitta halqani tasvirlardi.
 * Birga turganda sabab va oqibat koʻrinadi: oʻqitasiz va shu
 * raqamlar qanday oʻzgarganini kuzatasiz.
 */
export default function Knowledge() {
  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState([]);
  const [skills, setSkills] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [tab, setTab] = useState("docs");
  const [q, setQ] = useState("");
  const [add, setAdd] = useState({ title: "", content: "" });
  const [error, setError] = useState(null);

  const load = useCallback(
    async (silent = false) => {
      try {
        const [s, d, sk] = await Promise.all([
          client.get(ENDPOINTS.STATUS, { silent }),
          client.get(ENDPOINTS.KNOWLEDGE(100, q), { silent }),
          client.get(ENDPOINTS.SKILLS, { silent }),
        ]);
        setStatus(s);
        setDocs(d.items || d || []);
        setSkills(sk || []);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [q]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab !== "prompt") return;
    client
      .get(ENDPOINTS.PROMPT_PREVIEW)
      .then((r) => setPrompt(r.prompt || r.text || JSON.stringify(r, null, 2)))
      .catch((e) => setPrompt(e.message));
  }, [tab]);

  // Oʻqitish ketayotganda tez-tez soʻraymiz — progress chizigʻi
  // haqiqatan harakatlansin
  useEffect(() => {
    if (!status?.training?.running) return;
    const t = setInterval(() => load(true), 4000);
    return () => clearInterval(t);
  }, [status?.training?.running, load]);

  const training = status?.training || {};
  const kn = status?.knowledge || {};
  const bySource = (kn.bySource || []).map((s) => ({ name: s.source, value: s.c }));

  return (
    <>
      <PageHead>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
        <button
          type="button"
          className="btn"
          disabled={training.running}
          onClick={async () => {
            await client.post(ENDPOINTS.TRAINING_RUN, {});
            load();
          }}
        >
          <TbPlayerPlay size={14} /> {training.running ? "Oʻqitilmoqda…" : "Oʻqitishni boshlash"}
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <div className="grid c4">
        <Stat label="Hujjatlar" value={num(kn.documents)} sub={`${num(kn.qaPairs)} savol-javob`} />
        <Stat label="Koʻnikmalar" value={num(status?.skills)} sub="oʻrganilgan qoidalar" tone="ok" />
        <Stat label="Shaxsiyat" value={`v${status?.prompt?.version ?? "—"}`} sub="joriy versiya" tone="info" />
        <Stat
          label="Oxirgi oʻqitish"
          value={training.lastAt ? ago(training.lastAt) : "—"}
          sub="avtomatik takrorlanadi"
          tone="warn"
        />
      </div>

      {training.running && (
        <Card title="Oʻqitish jarayoni" icon={TbCpu}>
          <Meter
            label={training.phase || "boshlanmoqda"}
            value={training.progress || 0}
            max={100}
            right={`${training.progress || 0}%`}
          />
          {training.message && (
            <div className="hint" style={{ marginTop: "var(--gap-8)" }}>
              {training.message}
            </div>
          )}
        </Card>
      )}

      <div className="grid c2">
        <Card title="Bilim tarkibi" icon={TbBook2}>
          {bySource.length ? (
            <DonutChart
              data={bySource}
              center={
                <>
                  <div className={styles.big}>{num(kn.documents)}</div>
                  <div className="hint">hujjat</div>
                </>
              }
            />
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="Yangi fakt qoʻshish" icon={TbPlus}>
          <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
            Bu yerga qoʻshilgan maʼlumot javob berishda ishlatiladi. Qisqa va aniq yozing —
            agent uni oʻz soʻzlari bilan aytib beradi.
          </p>

          <label className="field">
            <span>Sarlavha</span>
            <input
              type="text"
              value={add.title}
              onChange={(e) => setAdd({ ...add, title: e.target.value })}
              placeholder="Masalan: ish vaqti"
            />
          </label>

          <label className="field">
            <span>Matn</span>
            <textarea
              value={add.content}
              onChange={(e) => setAdd({ ...add, content: e.target.value })}
              placeholder="Masalan: dushanbadan shanbagacha, 9:00 dan 18:00 gacha."
            />
          </label>

          <div className="row end">
            <button
              type="button"
              className="btn"
              disabled={!add.content.trim()}
              onClick={async () => {
                await client.post(ENDPOINTS.KNOWLEDGE(), add);
                setAdd({ title: "", content: "" });
                load();
              }}
            >
              <TbPlus size={14} /> Qoʻshish
            </button>
          </div>
        </Card>
      </div>

      <Card
        title={tab === "docs" ? "Bilim bazasi" : tab === "skills" ? "Koʻnikmalar" : "Shaxsiyat"}
        icon={tab === "skills" ? TbStar : tab === "prompt" ? TbUser : TbBook2}
        actions={
          <>
            <div className={styles.tabs}>
              {[
                ["docs", "Hujjatlar"],
                ["skills", "Koʻnikmalar"],
                ["prompt", "Shaxsiyat"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${styles.tab} ${tab === id ? styles.tabOn : ""}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "docs" && (
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Qidirish…"
                style={{ width: 180 }}
              />
            )}
          </>
        }
      >
        {tab === "docs" &&
          (docs.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sarlavha</th>
                    <th>Matn</th>
                    <th>Manba</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="anim-stagger">
                  {docs.map((d, i) => (
                    <tr key={d.id} style={{ "--i": i }}>
                      <td>{d.title || "—"}</td>
                      <td style={{ maxWidth: 460 }}>
                        <div className="hint">{String(d.content || "").slice(0, 200)}</div>
                      </td>
                      <td>
                        <Badge>{d.source}</Badge>
                      </td>
                      <td>
                        <div className="row end">
                          <button
                            type="button"
                            className="btn danger sm"
                            onClick={async () => {
                              await client.delete(ENDPOINTS.KNOWLEDGE_ITEM(d.id));
                              load();
                            }}
                          >
                            <TbTrash size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Hujjat topilmadi</Empty>
          ))}

        {tab === "skills" &&
          (skills.length ? (
            <div className={styles.skills}>
              {skills.map((s) => (
                <div key={s.slug} className={styles.skill}>
                  <div className="row">
                    <strong>{s.title || s.slug}</strong>
                    {!s.enabled && <Badge>oʻchiq</Badge>}
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn danger sm"
                      onClick={async () => {
                        await client.delete(ENDPOINTS.SKILL(s.slug));
                        load();
                      }}
                    >
                      <TbTrash size={13} />
                    </button>
                  </div>
                  <div className="hint">{s.body || s.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Koʻnikma yoʻq</Empty>
          ))}

        {tab === "prompt" && (
          <pre className="block" style={{ maxHeight: 560 }}>
            {prompt || "Yuklanmoqda…"}
          </pre>
        )}
      </Card>
    </>
  );
}
