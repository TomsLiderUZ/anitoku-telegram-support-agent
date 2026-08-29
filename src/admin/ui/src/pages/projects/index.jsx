import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  TbArrowLeft,
  TbDeviceFloppy,
  TbFile,
  TbPlayerPlay,
  TbPlayerStop,
  TbPlus,
  TbRefresh,
  TbRotate,
  TbStack2,
  TbTerminal,
  TbTrash,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { Badge, Card, Empty, ErrorBox, Loading, PageHead } from "../../components/ui";
import { ago } from "../../utils/format";

/**
 * Loyihalar — agent yozgan HAMMA narsa bitta roʻyxatda.
 *
 * MUHIM QOIDA: Telegram bot ham, sayt ham, oddiy skript ham shu
 * yerda va ular BIR XIL. Ilgari botlar alohida boʻlimda edi va bu
 * yolgʻon farq tugʻdirardi: go'yo bot "boshqacharoq" narsa, uni
 * boshqacha yozish kerak. Aslida hammasi bir xil yoʻl bilan boradi —
 * agent kod yozadi, sinaydi, ishga tushiradi. `kind` faqat YORLIQ:
 * u nima ishga tushirilishini bildiradi, xolos.
 */

/** Loyiha turlari — yangi loyiha ochishda tanlanadi. */
const KINDS = [
  ["node", "Node.js dastur"],
  ["telegram-bot", "Telegram bot"],
  ["web-site", "Veb-sayt"],
  ["script", "Bir martalik skript"],
];

const KIND_LABEL = Object.fromEntries(KINDS);

export default function Projects() {
  const { slug } = useParams();
  return slug ? <ProjectDetail slug={slug} /> : <ProjectList />;
}

/* ══════════════════════════════════════════════════════════════
   Roʻyxat
   ══════════════════════════════════════════════════════════════ */
function ProjectList() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "node", spec: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async (silent = false) => {
      try {
        setData(await client.get(ENDPOINTS.PROJECTS(showAll), { silent }));
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [showAll]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data && !error) return <Loading rows={3} />;

  const projects = data?.projects || [];

  const create = async () => {
    if (!draft.name.trim()) return;
    setCreating(true);
    try {
      const out = await client.post(ENDPOINTS.PROJECTS(), draft);
      setDraft({ name: "", kind: "node", spec: "" });
      load();
      if (out?.slug) navigate(`/projects/${out.slug}`);
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <PageHead>
        <label className={styles.toggle}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Arxivdagilar ham
        </label>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <Card title="Yangi loyiha" icon={TbPlus}>
        <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
          Nomi va nima qilishi kerakligini yozing — qolganini agent oʻzi qiladi: kodini yozadi,
          sinaydi va ishga tushiradi.
        </p>

        <div className={styles.newProject}>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Loyiha nomi"
          />
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            {KINDS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={draft.spec}
            onChange={(e) => setDraft({ ...draft, spec: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Nima qilishi kerak?"
          />
          <button type="button" className="btn" onClick={create} disabled={creating || !draft.name.trim()}>
            <TbPlus size={14} /> Boshlash
          </button>
        </div>
      </Card>

      <Card
        title={`Loyihalar (${projects.length})`}
        icon={TbStack2}
        actions={
          <Badge tone="info">{projects.filter((p) => p.running).length} ta ishlamoqda</Badge>
        }
      >
        {projects.length ? (
          <div className={`${styles.grid} anim-stagger`}>
            {projects.map((p, i) => (
              <button
                key={p.slug}
                type="button"
                className={styles.project}
                style={{ "--i": i }}
                onClick={() => navigate(`/projects/${p.slug}`)}
              >
                <div className={styles.projectTop}>
                  <strong className={styles.projectName}>{p.name || p.slug}</strong>
                  <Badge tone={p.running ? "ok" : p.deployed ? "info" : ""} pulse={p.running}>
                    {p.running ? "ishlamoqda" : p.deployed ? "joylashtirilgan" : "toʻxtagan"}
                  </Badge>
                </div>

                <p className={styles.projectSpec}>{p.spec || "tavsif yoʻq"}</p>

                <div className={styles.projectMeta}>
                  <Badge>{KIND_LABEL[p.kind] || p.kind}</Badge>
                  {p.port && <span className="mono">:{p.port}</span>}
                  <span className="spacer" />
                  <span>{p.updated_at ? ago(p.updated_at) : ""}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty icon={TbStack2}>Hali loyiha yoʻq — yuqoridan yangisini boshlang</Empty>
        )}
      </Card>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Bitta loyiha
   ══════════════════════════════════════════════════════════════ */
function ProjectDetail({ slug }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState([]);
  const [openFile, setOpenFile] = useState(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [logs, setLogs] = useState("");
  const [project, setProject] = useState(null);
  const [runCmd, setRunCmd] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      try {
        const [list, all, lg] = await Promise.all([
          client.get(ENDPOINTS.PROJECT_FILES(slug), { silent }),
          client.get(ENDPOINTS.PROJECTS(true), { silent }),
          client.get(ENDPOINTS.PROJECT_LOGS(slug, 200), { silent }),
        ]);
        setFiles(list.files || []);
        setLogs(lg.logs || "");

        const found = (all.projects || []).find((p) => p.slug === slug);
        setProject(found || null);
        // Faqat tahrirlanmagan boʻlsa yangilaymiz — yozayotgan
        // buyruq fon yangilanishida yoʻqolib ketmasin.
        setRunCmd((prev) => (prev ? prev : found?.run_cmd || found?.runCmd || ""));
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [slug]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const open = async (path) => {
    try {
      const r = await client.get(ENDPOINTS.PROJECT_FILE(slug, path));
      setOpenFile(path);
      setContent(r.content ?? r.code ?? "");
      setDirty(false);
    } catch (e) {
      setError(e);
    }
  };

  const save = async () => {
    if (!openFile) return;
    setBusy(true);
    try {
      await client.post(ENDPOINTS.PROJECT_FILE(slug, openFile), { path: openFile, content });
      setDirty(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const act = async (endpoint) => {
    setBusy(true);
    try {
      await client.post(endpoint);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title={project?.name || slug} desc={project?.spec}>
        <button type="button" className="btn ghost sm" onClick={() => navigate("/projects")}>
          <TbArrowLeft size={14} /> Orqaga
        </button>
        {project?.running ? (
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => act(ENDPOINTS.PROJECT_STOP(slug))}
          >
            <TbPlayerStop size={14} /> Toʻxtatish
          </button>
        ) : (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => act(ENDPOINTS.PROJECT_START(slug))}
          >
            <TbPlayerPlay size={14} /> Ishga tushirish
          </button>
        )}
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy}
          onClick={() => act(ENDPOINTS.PROJECT_RESTART(slug))}
        >
          <TbRotate size={14} /> Qayta
        </button>
        <button
          type="button"
          className="btn danger sm"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm("Loyiha butunlay oʻchirilsinmi?")) return;
            await client.delete(ENDPOINTS.PROJECT(slug));
            navigate("/projects");
          }}
        >
          <TbTrash size={14} />
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <div className={styles.detail}>
        <Card title="Fayllar" icon={TbFile}>
          <div className={styles.fileList}>
            {files.length ? (
              files.map((f) => {
                const path = typeof f === "string" ? f : f.path;
                return (
                  <button
                    key={path}
                    type="button"
                    className={`${styles.file} ${openFile === path ? styles.fileOn : ""}`}
                    onClick={() => open(path)}
                  >
                    {path}
                  </button>
                );
              })
            ) : (
              <Empty>Fayl yoʻq</Empty>
            )}
          </div>
        </Card>

        <Card
          title={openFile || "Fayl tanlang"}
          icon={TbFile}
          actions={
            openFile && (
              <>
                {dirty && <Badge tone="warn">saqlanmagan</Badge>}
                <button type="button" className="btn sm" onClick={save} disabled={!dirty || busy}>
                  <TbDeviceFloppy size={14} /> Saqlash
                </button>
              </>
            )
          }
        >
          {openFile ? (
            <textarea
              className={styles.editor}
              value={content}
              spellCheck={false}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
            />
          ) : (
            <Empty icon={TbFile}>Chapdagi roʻyxatdan fayl tanlang</Empty>
          )}
        </Card>
      </div>

      <Card title="Ishga tushirish buyrugʻi" icon={TbTerminal}>
        <p className="hint" style={{ marginBottom: "var(--gap-10)" }}>
          Boʻsh qoldirilsa agent loyiha turiga qarab oʻzi aniqlaydi.
        </p>
        <div className="row">
          <input
            type="text"
            value={runCmd}
            onChange={(e) => setRunCmd(e.target.value)}
            placeholder="node index.js"
            className="mono grow"
          />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              await client.post(ENDPOINTS.PROJECT_SETTINGS(slug), { runCmd });
              load();
            }}
          >
            <TbDeviceFloppy size={14} /> Saqlash
          </button>
        </div>
      </Card>

      <Card
        title="Jurnal"
        icon={TbTerminal}
        actions={<button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={13} />
        </button>}
      >
        {logs ? (
          <pre className={`block ${styles.logs}`}>{logs}</pre>
        ) : (
          <Empty icon={TbTerminal}>Jurnal boʻsh</Empty>
        )}
      </Card>
    </>
  );
}
