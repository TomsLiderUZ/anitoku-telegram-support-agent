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
  TbPencil,
  TbDeviceFloppy,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { DonutChart } from "../../components/charts";
import { Badge, Card, Empty, ErrorBox, Meter, Modal, PageHead, Stat } from "../../components/ui";
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

  // Tahrirlanayotgan hujjat: `editing` — serverdagi holati, `draft` —
  // ekrandagi. Ikkalasi alohida turadi, shunda "nimadir o'zgardimi?"
  // degan savolga aniq javob bor va o'zgarmagan holda "Saqlash"
  // bosilmaydi.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState(null);

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

  /**
   * Hujjatni to'liq matni bilan ochish.
   *
   * Ro'yxatda faqat 300 belgilik parcha keladi — yuzta hujjatning to'liq
   * matnini har safar tashish ma'nosiz. To'liq matn aynan shu yerda,
   * ochilganda so'raladi.
   */
  const openDoc = async (id) => {
    setEditError(null);
    try {
      const item = await client.get(ENDPOINTS.KNOWLEDGE_ITEM(id));
      setEditing(item);
      setDraft({ title: item.title || "", content: item.content || "" });
    } catch (e) {
      setError(e);
    }
  };

  const saveDoc = async () => {
    setSaving(true);
    setEditError(null);
    try {
      await client.post(ENDPOINTS.KNOWLEDGE_ITEM(editing.id), {
        title: draft.title,
        content: draft.content,
      });
      setEditing(null);
      load();
    } catch (e) {
      // Server takrorlanish yoki qisqa matn haqida aytadi — oynani
      // yopmaymiz, aks holda yozilgan matn yo'qolardi.
      setEditError(e);
    } finally {
      setSaving(false);
    }
  };

  const changed =
    Boolean(editing) &&
    (draft.title !== (editing.title || "") || draft.content !== (editing.content || ""));

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
                await client.post(ENDPOINTS.KNOWLEDGE_ADD, add);
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
            <div className={`${styles.tabs} swipe`}>
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
                className={styles.search}
              />
            )}
          </>
        }
      >
        {tab === "docs" &&
          (docs.length ? (
            /* Jadval emas, ro'yxat: tor ekranda jadval yon tomonga
               suriladi va matn ustunini o'qib bo'lmaydi. Bandning
               o'ziga bosilsa to'liq matn ochiladi. */
            <div className={`${styles.docs} anim-stagger`}>
              {docs.map((d, i) => (
                <button
                  key={d.id}
                  type="button"
                  className={styles.doc}
                  style={{ "--i": i }}
                  onClick={() => openDoc(d.id)}
                >
                  <div className={styles.docTop}>
                    <strong className={styles.docTitle}>{d.title || "Sarlavhasiz"}</strong>
                    <Badge>{d.source}</Badge>
                    {!d.enabled && <Badge tone="warn">oʻchiq</Badge>}
                  </div>
                  <p className={styles.docPreview}>{d.preview || d.content}</p>
                  <div className={styles.docMeta}>
                    <TbPencil size={12} /> tahrirlash uchun bosing · {ago(d.updated_at)}
                  </div>
                </button>
              ))}
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

      {/* ── Hujjatni to'liq o'qish va tahrirlash ───────────────── */}
      <Modal
        open={Boolean(editing)}
        title={editing?.title || `Hujjat #${editing?.id}`}
        onClose={() => setEditing(null)}
        actions={
          <>
            <button
              type="button"
              className="btn danger sm"
              onClick={async () => {
                if (!window.confirm("Hujjat butunlay oʻchirilsinmi?")) return;
                await client.delete(ENDPOINTS.KNOWLEDGE_ITEM(editing.id));
                setEditing(null);
                load();
              }}
            >
              <TbTrash size={13} /> Oʻchirish
            </button>

            <span className="spacer" />

            <span className="hint">{(draft.content || "").length} belgi</span>
            <button type="button" className="btn ghost sm" onClick={() => setEditing(null)}>
              Bekor qilish
            </button>
            <button type="button" className="btn" onClick={saveDoc} disabled={saving || !changed}>
              <TbDeviceFloppy size={14} /> {saving ? "Saqlanmoqda…" : "Saqlash"}
            </button>
          </>
        }
      >
        {editing && (
          <>
            <ErrorBox error={editError} />

            <div className={styles.docInfo}>
              <Badge>{editing.source}</Badge>
              {editing.source_ref && <span className="hint mono">{editing.source_ref}</span>}
              <span className="spacer" />
              <span className="hint">
                #{editing.id} · yangilangan {ago(editing.updated_at)}
              </span>
            </div>

            <label className="field">
              <span>Sarlavha</span>
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Sarlavhasiz"
              />
            </label>

            <label className="field">
              <span>Matn</span>
              {/* Balandligi oynaga qarab — uzun hujjatni 4 qatorlik
                  darchadan tahrirlash iloji yo'q */}
              <textarea
                className={styles.docEditor}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                spellCheck={false}
              />
              <small>
                Shu matn mijozlarga javob berishda ishlatiladi. Oʻzgartirilgach agent uni
                qaytadan indekslaydi.
              </small>
            </label>
          </>
        )}
      </Modal>
    </>
  );
}
