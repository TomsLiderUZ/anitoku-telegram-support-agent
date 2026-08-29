import { useCallback, useEffect, useState } from "react";
import {
  TbClockHour4,
  TbEye,
  TbListCheck,
  TbPlayerStop,
  TbPlus,
  TbRefresh,
  TbRepeat,
  TbTrash,
  TbProgress,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { Badge, Card, Empty, ErrorBox, Meter, PageHead, Stat } from "../../components/ui";
import { ago, num, time } from "../../utils/format";

/**
 * Vazifalar — fonda ketayotgan ishlar, muntazam ratsion va kuzatuvlar.
 *
 * Uchalasi bitta sahifada, chunki javob beradigan savol bitta: "agent
 * hozir nima ustida ishlayapti va yana nima qilishi rejalashtirilgan?"
 * Ularni bo'lib yuborish bu savolni uchta ekranga tarqatib yuborardi.
 */

const STATUS = {
  pending: ["kutmoqda", "warn"],
  running: ["bajarilmoqda", "info"],
  done: ["bajarildi", "ok"],
  failed: ["xato", "danger"],
  cancelled: ["bekor qilindi", ""],
};

/** Vaqt yozuvining ko'rinishi — foydalanuvchi qanday yozishini bilsin.
 *  Bu MISOL, tayyor buyruq emas. */
const SCHEDULE_HINT = "har kuni 09:00 · har 30 daqiqada · dushanba 18:30";

/** Ro'yxat egasining turi — kim uchun tuzilgani. */
const KIND_LABEL = { coder: 'kod', assistant: 'buyruq', routine: 'ratsion' };

/** Bosqich holatining belgisi. Rang bilan birga SHAKL ham beriladi:
 *  rang ko'rmaslik holatida ham holat farqlanib tursin. */
const STEP_MARK = { done: '✓', in_progress: '▸', blocked: '✕', skipped: '–', pending: '○' };

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [routines, setRoutines] = useState([]);
  const [watches, setWatches] = useState([]);
  const [activity, setActivity] = useState(null);
  const [draft, setDraft] = useState({ title: "", instruction: "", schedule: "" });
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [t, r, w, a] = await Promise.all([
        client.get(ENDPOINTS.TASKS(100), { silent }),
        client.get(ENDPOINTS.ROUTINES, { silent }),
        client.get(ENDPOINTS.WATCHES, { silent }),
        client.get(ENDPOINTS.ACTIVITY(1), { silent }),
      ]);
      setTasks(t || []);
      setRoutines(r || []);
      setWatches(w || []);
      setActivity(a || null);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
    // Ish ketayotganda 15 soniya uzoq — foiz sakrab emas, siljib
    // borishi kerak. 6 soniya jonli, lekin serverga ham yengil.
    const t = setInterval(() => load(true), 6000);
    return () => clearInterval(t);
  }, [load]);

  const active = tasks.filter((t) => t.status === "pending" || t.status === "running");
  const checklists = activity?.checklists || [];

  const addRoutine = async () => {
    if (!draft.instruction.trim() || !draft.schedule.trim()) return;
    try {
      await client.post(ENDPOINTS.ROUTINES, draft);
      setDraft({ title: "", instruction: "", schedule: "" });
      load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <PageHead>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      {/* ── Hozir bajarilayotgan ish ──────────────────────────────
          Agent har bir uzun ish uchun oʻziga roʻyxat tuzadi va
          bandlarni bajarilgani sari belgilaydi. Foiz aynan shundan
          chiqadi — taxmin emas, agentning oʻz hisobi. */}
      {checklists.length > 0 && (
        <Card
          title="Hozir bajarilmoqda"
          icon={TbProgress}
          actions={
            <Badge tone={checklists.every((c) => c.stalled) ? "warn" : "info"} pulse={checklists.some((c) => !c.stalled)}>
              {checklists.length} ta ish
            </Badge>
          }
        >
          <div className={styles.jobs}>
            {checklists.map((c) => (
              <div key={c.owner} className={styles.job}>
                <div className={styles.jobTop}>
                  <Badge tone={c.kind === "coder" ? "info" : ""}>{KIND_LABEL[c.kind] || c.kind}</Badge>
                  <strong className={styles.jobName}>{c.subject || c.owner}</strong>
                  {c.blocked > 0 && <Badge tone="danger">{c.blocked} toʻsiq</Badge>}
                  {/* Yashirmaymiz, aytamiz: yarim soatdan beri qimirlamagan
                      ish tugagan emas — toʻxtab qolgan. */}
                  {c.stalled && <Badge tone="warn">toʻxtab qolgan</Badge>}
                  <span className="spacer" />
                  <span className={styles.jobPercent}>{c.percent}%</span>
                </div>

                <Meter
                  label={c.current || "keyingi bosqich kutilmoqda"}
                  value={c.done}
                  max={c.total}
                  tone={c.blocked || c.stalled ? "warn" : c.percent === 100 ? "ok" : ""}
                  right={`${c.done}/${c.total}`}
                />

                <ol className={styles.steps}>
                  {c.items.map((it, i) => (
                    <li key={it.id} className={`${styles.step} ${styles[`step_${it.status}`]}`} style={{ "--i": i }}>
                      <span className={styles.stepMark} aria-hidden="true">
                        {STEP_MARK[it.status] || "○"}
                      </span>
                      <span>
                        {it.text}
                        {it.note && <em className={styles.stepNote}> — {it.note}</em>}
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="hint">Oxirgi harakat: {ago(c.updatedAt)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid c4">
        <Stat label="Hozir ishlamoqda" value={num(active.length)} sub="navbat va bajarilayotgan" tone="info" />
        <Stat label="Muntazam ratsion" value={num(routines.filter((r) => r.enabled).length)} sub={`${routines.length} tadan yoqilgan`} tone="ok" />
        <Stat label="Kuzatuvlar" value={num(watches.filter((w) => w.status === "open").length)} sub="javob kutilmoqda" tone="warn" />
        <Stat label="Bajarilgan" value={num(tasks.filter((t) => t.status === "done").length)} sub="oxirgi 100 tadan" />
      </div>

      {/* ── Muntazam ratsion ──────────────────────────────────── */}
      <Card title="Muntazam ratsion" icon={TbRepeat}>
        <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
          Bu yerga qoʻshilgan ish belgilangan vaqtda oʻzi takrorlanadi — siz eslatmasangiz ham.
        </p>

        <div className={styles.newRoutine}>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Nomi (ixtiyoriy)"
          />
          <input
            type="text"
            value={draft.schedule}
            onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}
            placeholder={SCHEDULE_HINT}
          />
          <input
            type="text"
            value={draft.instruction}
            onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && addRoutine()}
            placeholder="Nima qilinsin?"
          />
          <button
            type="button"
            className="btn"
            onClick={addRoutine}
            disabled={!draft.instruction.trim() || !draft.schedule.trim()}
          >
            <TbPlus size={14} /> Qoʻshish
          </button>
        </div>

        {routines.length ? (
          <div className="table-wrap" style={{ marginTop: "var(--gap-16)" }}>
            <table>
              <thead>
                <tr>
                  <th>Ish</th>
                  <th>Qachon</th>
                  <th>Keyingisi</th>
                  <th className="num">Bajarilgan</th>
                  <th />
                </tr>
              </thead>
              <tbody className="anim-stagger">
                {routines.map((r, i) => (
                  <tr key={r.id} style={{ "--i": i }}>
                    <td>
                      <strong className={styles.rowTitle}>{r.title || r.instruction}</strong>
                      {r.title && <div className="hint">{r.instruction}</div>}
                    </td>
                    <td>
                      <Badge tone={r.enabled ? "ok" : ""}>{r.schedule}</Badge>
                    </td>
                    <td className="hint">{r.nextRun || "—"}</td>
                    <td className="num">{num(r.runs)}</td>
                    <td>
                      <div className="row end">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={async () => {
                            await client.post(ENDPOINTS.ROUTINE_TOGGLE(r.id));
                            load();
                          }}
                        >
                          {r.enabled ? "Oʻchirish" : "Yoqish"}
                        </button>
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={async () => {
                            if (!window.confirm("Ratsion oʻchirilsinmi?")) return;
                            await client.delete(ENDPOINTS.ROUTINE(r.id));
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
          <Empty icon={TbRepeat}>Muntazam ish qoʻshilmagan</Empty>
        )}
      </Card>

      {/* ── Vazifalar ─────────────────────────────────────────── */}
      <Card
        title="Vazifalar"
        icon={TbListCheck}
        actions={active.length ? <Badge tone="info" pulse>{active.length} faol</Badge> : null}
      >
        {tasks.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vazifa</th>
                  <th>Holat</th>
                  <th>Vaqt</th>
                  <th />
                </tr>
              </thead>
              <tbody className="anim-stagger">
                {tasks.map((t, i) => {
                  const [label, tone] = STATUS[t.status] || [t.status, ""];
                  return (
                    <tr key={t.id} style={{ "--i": i }}>
                      <td>
                        <strong className={styles.rowTitle}>{t.title || t.kind}</strong>
                        <div className="hint mono">{t.kind}</div>
                        {t.error && <div className={styles.err}>{t.error}</div>}
                      </td>
                      <td>
                        <Badge tone={tone} pulse={t.status === "running"}>
                          {label}
                        </Badge>
                      </td>
                      <td className="hint">
                        {t.finished_at ? ago(t.finished_at) : t.run_at ? time(t.run_at) : "—"}
                      </td>
                      <td>
                        {(t.status === "pending" || t.status === "running") && (
                          <div className="row end">
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={async () => {
                                await client.post(ENDPOINTS.TASK_CANCEL(t.id));
                                load();
                              }}
                            >
                              <TbPlayerStop size={13} /> Toʻxtatish
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={TbClockHour4}>Vazifa yoʻq</Empty>
        )}
      </Card>

      {/* ── Kuzatuvlar ────────────────────────────────────────── */}
      <Card title="Kuzatuvlar" icon={TbEye}>
        <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
          Agent kimningdir javobini kutayotgan boʻlsa shu yerda koʻrinadi — javob kelishi bilan
          ishni davom ettiradi.
        </p>

        {watches.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nima kutilmoqda</th>
                  <th>Chat</th>
                  <th>Holat</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {watches.map((w) => (
                  <tr key={w.id}>
                    <td>{w.reason || w.note || "javob"}</td>
                    <td className="hint">{w.chat_title || w.chat_id}</td>
                    <td>
                      <Badge tone={w.status === "open" ? "info" : ""}>{w.status}</Badge>
                    </td>
                    <td>
                      {w.status === "open" && (
                        <div className="row end">
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={async () => {
                              await client.post(`${ENDPOINTS.WATCHES}/${w.id}/cancel`);
                              load();
                            }}
                          >
                            Bekor qilish
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={TbEye}>Kuzatuv yoʻq</Empty>
        )}
      </Card>
    </>
  );
}
