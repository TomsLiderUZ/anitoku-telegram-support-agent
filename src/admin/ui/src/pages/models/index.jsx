import { useCallback, useEffect, useState } from "react";
import {
  TbBolt,
  TbCloudUpload,
  TbCpu,
  TbDeviceDesktop,
  TbDownload,
  TbKey,
  TbPlus,
  TbRefresh,
  TbTrash,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { RankChart } from "../../components/charts";
import { Badge, Card, Empty, ErrorBox, Meter, PageHead, Stat } from "../../components/ui";
import { ago, compact, dur, gb, ms, num } from "../../utils/format";

/**
 * AI modellar — bulut provayderlar va lokal modellar birga.
 *
 * Ular ikki sahifa edi, lekin javob beradigan qaror bitta: qaysi
 * model qaysi ishni bajaradi va bandlik qolganmi. Kalitlar holatini
 * lokal model yuki bilan yonma-yon koʻrish aynan shu qarorni
 * oʻz-oʻzidan ravshan qiladi.
 */

/** Lokal model bajarishi mumkin boʻlgan ishlar. Odam oʻqiydigan
 *  javob sukut boʻyicha bulutga ketadi — u yerda tezroq va aniqroq. */
const PURPOSES = [
  ["memory:summary", "Suhbat xulosasi"],
  ["reply:retry", "Javobni qayta urinish"],
  ["reply", "Mijozlarga javob"],
  ["assistant", "Sizning buyruqlaringiz"],
  ["coder", "Kod yozish"],
];

export default function Models() {
  const [keys, setKeys] = useState(null);
  const [local, setLocal] = useState(null);
  const [paste, setPaste] = useState("");
  const [provider, setProvider] = useState("");
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [k, l] = await Promise.all([
        client.get(ENDPOINTS.KEYS, { silent }),
        client.get(ENDPOINTS.LOCAL, { silent }),
      ]);
      setKeys(k);
      setLocal(l);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const setSetting = async (values) => {
    await client.post(ENDPOINTS.SETTINGS, { values });
    load();
  };

  const health = keys?.health || {};
  const providers = (keys?.providers || []).filter(
    (p) => health[p.id]?.total > 0 || p.id === provider
  );
  const usage = local?.usage || {};
  const activePurposes = new Set(local?.purposes || []);

  const keyChart = providers
    .map((p) => ({ name: p.label, value: health[p.id]?.available || 0 }))
    .filter((r) => r.value > 0);

  return (
    <>
      <PageHead>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={async () => {
            await client.post(ENDPOINTS.KEYS_REVIVE);
            load();
          }}
        >
          <TbBolt size={14} /> Kalitlarni tiklash
        </button>
      </PageHead>

      <ErrorBox error={error} onRetry={() => load()} />

      <div className="grid c2">
        <Card title="Kalitlar holati" icon={TbKey}>
          {providers.length ? (
            <div className={styles.keyGrid}>
              {providers.map((p) => {
                const h = health[p.id] || { total: 0, available: 0 };
                return (
                  <div key={p.id} className={styles.provider}>
                    <div className={styles.providerTop}>
                      <span className={styles.providerName}>{p.label}</span>
                      <span className="spacer" />
                      {h.available === 0 && h.total > 0 && <Badge tone="danger">bandlik tugagan</Badge>}
                      {h.disabled > 0 && <Badge tone="warn">{h.disabled} oʻchiq</Badge>}
                      {p.signup && (
                        <a href={p.signup} target="_blank" rel="noreferrer" className="hint">
                          kalit olish →
                        </a>
                      )}
                    </div>
                    <Meter
                      label="Tayyor kalitlar"
                      value={h.available}
                      max={h.total}
                      tone={h.available === 0 ? "danger" : h.available < h.total / 3 ? "warn" : "ok"}
                      right={`${h.available}/${h.total}${h.cooldown ? ` · ${h.cooldown} kutmoqda` : ""}`}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty icon={TbKey}>Kalit qoʻshilmagan</Empty>
          )}
        </Card>

        <Card title="Tayyor kalitlar taqsimoti" icon={TbKey}>
          {keyChart.length ? (
            <RankChart data={keyChart} height={Math.max(160, keyChart.length * 42)} />
          ) : (
            <Empty>Boʻsh kalit qolmagan</Empty>
          )}
        </Card>
      </div>

      <Card title="Kalit qoʻshish" icon={TbPlus}>
        <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
          Bir nechta kalitni birdaniga qoʻying — har qatorga bittadan. Provayder kalitning
          koʻrinishidan avtomatik aniqlanadi.
        </p>

        <label className="field">
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={4}
            placeholder={"gsk_…\nsk-or-v1-…\nAIza…"}
            className="mono"
          />
        </label>

        <div className="row end">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={{ width: "auto" }}
          >
            <option value="">Avtomatik aniqlash</option>
            {(keys?.providers || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={!paste.trim()}
            onClick={async () => {
              const r = await client.post(ENDPOINTS.KEYS, {
                keys: paste,
                provider: provider || undefined,
              });
              setPaste("");
              load();
              if (r?.invalid) {
                setError(new Error(`${r.invalid} ta kalit tanilmadi — provayderni qoʻlda tanlang`));
              }
            }}
          >
            <TbPlus size={14} /> Qoʻshish
          </button>
        </div>
      </Card>

      {/* ── Lokal modellar ────────────────────────────────────── */}
      <PageHead
        title="Lokal modellar"
        desc="Shu kompyuterda ishlaydi — bepul, lekin sekinroq. Fayl yoʻq boʻlsa bulut modellar ishlaydi"
      />

      <div className="grid c4">
        <Stat
          label="Chat modeli"
          value={
            local?.chat?.loaded
              ? "Yuklangan"
              : local?.chat?.present
                ? "Tayyor"
                : local?.chat?.downloading
                  ? "Yuklanmoqda"
                  : "Yoʻq"
          }
          sub={local?.chat?.label}
          tone={local?.chat?.loaded ? "ok" : ""}
        />
        <Stat
          label="Tezlatgich"
          value={String(local?.gpu || "—").toUpperCase()}
          sub={local?.contextSize ? `${num(local.contextSize)} token kontekst` : "yuklanmagan"}
          tone="info"
        />
        <Stat
          label="Chaqiruvlar"
          value={num(usage.calls)}
          sub={`${usage.failed || 0} xato · RPM ${usage.rpm || 0}`}
        />
        <Stat label="Tezlik" value={ms(usage.avgMs)} sub={`eng uzun ${ms(usage.maxMs)}`} tone="warn" />
      </div>

      <div className="grid c2">
        <Card title="Modellar" icon={TbDeviceDesktop}>
          {["chat", "code", "embed"].map((kind) => {
            const m = local?.[kind];
            if (!m) return null;
            return (
              <div key={kind} className={styles.provider}>
                <div className={styles.providerTop}>
                  <span className={styles.providerName}>{m.label}</span>
                  <span className="spacer" />
                  <Badge tone={m.loaded ? "ok" : m.present ? "info" : m.downloading ? "warn" : ""}>
                    {m.loaded ? "xotirada" : m.present ? "diskda" : m.downloading ? "yuklanmoqda" : "yoʻq"}
                  </Badge>
                </div>

                <div className="hint mono">
                  {m.file} · {m.sizeGb} GB
                  {m.present ? ` · diskda ${gb(m.bytes)}` : m.downloading ? ` · ${gb(m.bytes)}` : ""}
                </div>

                {!m.present && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginTop: "var(--gap-8)" }}
                    onClick={() => client.post(ENDPOINTS.LOCAL_DOWNLOAD(kind)).then(() => load())}
                  >
                    <TbDownload size={13} /> Yuklab olish
                  </button>
                )}
              </div>
            );
          })}

          <div className="row" style={{ marginTop: "var(--gap-12)" }}>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => client.post(ENDPOINTS.LOCAL_LOAD).then(() => load())}
            >
              <TbCloudUpload size={13} /> Xotiraga yuklash
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => client.post(ENDPOINTS.LOCAL_UNLOAD).then(() => load())}
            >
              <TbTrash size={13} /> Boʻshatish
            </button>
          </div>
        </Card>

        <Card title="Sozlash" icon={TbCpu}>
          <label className="field">
            <span>Tezlatgich</span>
            <select
              value={local?.backend || "auto"}
              onChange={(e) => setSetting({ local_backend: e.target.value })}
            >
              <option value="auto">Avtomatik</option>
              <option value="vulkan">Vulkan (GPU)</option>
              <option value="cuda">CUDA (GPU)</option>
              <option value="cpu">Faqat CPU — sekin, lekin barqaror</option>
            </select>
            <small>Model yiqilaversa CPU'ga oʻtkazing; oʻzgarish keyingi yuklashda kuchga kiradi</small>
          </label>

          <label className="field">
            <span>Profil</span>
            <select
              value={local?.profile || "auto"}
              onChange={(e) => setSetting({ local_profile: e.target.value })}
            >
              <option value="auto">Avtomatik ({local?.ramGb} GB RAM)</option>
              <option value="gpu">GPU — 7B modellar</option>
              <option value="cpu-small">Kichik server — 1B</option>
            </select>
          </label>

          <div className="field">
            <span>Qaysi ishlarni lokal model bajarsin</span>
            <div className={styles.purposeGrid}>
              {PURPOSES.map(([id, label]) => (
                <label key={id} className={styles.purpose}>
                  <input
                    type="checkbox"
                    checked={activePurposes.has(id)}
                    onChange={(e) => {
                      const next = new Set(activePurposes);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      setSetting({ local_purposes: [...next].join(",") });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            <small>
              Belgilanmaganlari bulut modellarga ketadi. Odam oʻqiydigan javob va kod uchun bulut
              tezroq va ishonchliroq.
            </small>
          </div>

          {usage.byPurpose?.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ish turi</th>
                    <th className="num">Chaqiruv</th>
                    <th className="num">Oʻrtacha</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byPurpose.map((p) => (
                    <tr key={p.purpose}>
                      <td className="mono">{p.purpose}</td>
                      <td className="num">{num(p.calls)}</td>
                      <td className="num">{ms(p.avgMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="hint" style={{ marginTop: "var(--gap-12)" }}>
            Ishlash vaqti: {usage.uptimeSec ? dur(usage.uptimeSec) : "—"}
            {usage.crashes ? ` · ${usage.crashes} marta yiqilgan` : " · barqaror"}
            {usage.lastCrashAt ? ` (oxirgisi ${ago(usage.lastCrashAt)})` : ""}
            {usage.tokens24h ? ` · 24 soatda ${compact(usage.tokens24h)} token` : ""}
          </div>
        </Card>
      </div>
    </>
  );
}
