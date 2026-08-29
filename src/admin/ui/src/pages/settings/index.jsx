import { useCallback, useEffect, useRef, useState } from "react";
import {
  TbDeviceMobile,
  TbLink,
  TbLogout,
  TbRefresh,
  TbDeviceFloppy,
  TbSettings,
} from "react-icons/tb";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import { startTelegramLoginSession } from "../../api/telegramLoginSocket";
import { Badge, Card, ErrorBox, PageHead } from "../../components/ui";
import { time } from "../../utils/format";

/**
 * Sozlamalar — Telegram ulanishi va agent xulqi.
 *
 * Telegram shu yerda, chunki akkauntni ulash bir marta qilinadigan
 * SOZLASH ishi. Jurnal esa oʻz boʻlimiga koʻchdi: u kuzatuv quroli,
 * sozlama emas, va unga butun ekran kengligi kerak edi.
 */

/** Qoʻlda oʻzgartirishga arziydigan sozlamalar; qolganini agent oʻzi
 *  boshqaradi. Bu roʻyxat ataylab qisqa — har bir qoʻshimcha sozlama
 *  "buni tegishim kerakmi?" degan savol tugʻdiradi. */
const FIELDS = [
  ["auto_reply", "Avtomatik javob", "bool", "Oʻchirilsa agent hech kimga javob bermaydi"],
  ["reply_to_private", "Shaxsiy chatlarga javob", "bool", ""],
  ["reply_in_groups", "Guruhlarda javob", "bool", "Guruhda faqat mavzuga aloqador xabarlarga javob beradi"],
  ["keep_online", "Doim online koʻrinish", "bool", ""],
  ["typing_simulation", '"Yozmoqda" holati', "bool", "Javob tayyorlanayotganda koʻrsatiladi"],
  ["founder_private_replies", "Javoblar faqat shaxsiy chatga", "bool", "Guruhda soʻralsa ham sizga shaxsiy yoziladi"],
  ["min_delay_ms", "Eng kam kechikish (ms)", "num", ""],
  ["max_delay_ms", "Eng koʻp kechikish (ms)", "num", ""],
  ["debounce_ms", "Xabarlarni birlashtirish (ms)", "num", "Ketma-ket kelgan xabarlarni kutish vaqti"],
  ["max_replies_per_chat_hour", "Bir chatga soatiga koʻpi bilan", "num", ""],
  ["quiet_hours", "Sukut soatlari", "text", "Masalan 01:00-07:00 — bu oraliqda javob bermaydi"],
  ["escalation_chat_id", "Savollar yuboriladigan chat", "text", "Agent javob berolmagan savollar shu chatga tushadi"],
];

export default function Settings() {
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [tg, setTg] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState(null);
  const qrSession = useRef(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [s, t] = await Promise.all([
        client.get(ENDPOINTS.SETTINGS, { silent }),
        client.get(ENDPOINTS.TELEGRAM.INFO, { silent }),
      ]);
      setValues(s.values || {});
      setTg(t);
      setPhone((prev) => prev || t.phone || "");
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Sahifadan chiqilganda QR sessiyasi albatta yopiladi — aks holda
  // u fonda soʻrov yuborishda davom etardi.
  useEffect(() => () => qrSession.current?.(), []);

  const startQr = () => {
    setError(null);
    qrSession.current?.();
    qrSession.current = startTelegramLoginSession({
      onUpdate: (state) => {
        setQr(state);
        if (state.info) setTg(state.info);
      },
      onDone: () => load(true),
      onError: (e) => setError(e),
    });
  };

  const save = async () => {
    if (!Object.keys(dirty).length) return;
    try {
      const r = await client.post(ENDPOINTS.SETTINGS, { values: dirty });
      setDirty({});
      setValues(r.values || values);
      if (r.ignored?.length) setError(new Error(`Qabul qilinmadi: ${r.ignored.join(", ")}`));
    } catch (e) {
      setError(e);
    }
  };

  const val = (k) => (k in dirty ? dirty[k] : (values[k] ?? ""));
  const connected = tg?.status === "connected";

  return (
    <>
      <PageHead>
        <button type="button" className="btn ghost sm" onClick={() => load()}>
          <TbRefresh size={14} /> Yangilash
        </button>
        <button type="button" className="btn" onClick={save} disabled={!Object.keys(dirty).length}>
          <TbDeviceFloppy size={14} /> Saqlash
        </button>
      </PageHead>

      <ErrorBox error={error} />

      <Card
        title="Telegram akkaunt"
        icon={TbDeviceMobile}
        actions={
          <Badge tone={connected ? "ok" : tg?.status === "error" ? "danger" : "warn"} pulse={connected}>
            {connected ? `@${tg.username}` : tg?.status || "—"}
          </Badge>
        }
      >
        {connected ? (
          <div className="row">
            <div>
              <strong>{tg.firstName}</strong> · @{tg.username}
              <div className="hint">
                ID {tg.userId} · {tg.phone} · {tg.connectedAt ? time(tg.connectedAt) : ""}
              </div>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="btn danger sm"
              onClick={async () => {
                if (!window.confirm("Telegram akkaunt uzilsinmi?")) return;
                await client.post(ENDPOINTS.TELEGRAM.LOGOUT, {});
                load();
              }}
            >
              <TbLogout size={13} /> Uzish
            </button>
          </div>
        ) : (
          <div className="grid c2">
            <div>
              <div className={styles.qr}>
                {qr?.svg ? (
                  <div dangerouslySetInnerHTML={{ __html: qr.svg }} />
                ) : (
                  <span className="hint">QR kodni olish uchun tugmani bosing</span>
                )}
              </div>

              <div className={styles.qrNote}>
                {qr?.status === "awaiting_qr" && !qr?.stale && (
                  <span className="hint">
                    Telefon → Sozlamalar → Qurilmalar → Kompyuterni ulash · {qr.expiresInSec}s ichida
                    yangilanadi
                  </span>
                )}
                {qr?.stale && <Badge tone="warn">Kod eskirdi — yangilang</Badge>}
                {qr?.expired && <Badge tone="danger">Skanerlanmadi — qaytadan boshlang</Badge>}
              </div>

              <button
                type="button"
                className="btn block"
                style={{ marginTop: "var(--gap-12)" }}
                onClick={startQr}
              >
                <TbLink size={14} /> {qr ? "QR kodni yangilash" : "QR kod bilan ulash"}
              </button>
            </div>

            <div>
              <p className="hint" style={{ marginBottom: "var(--gap-12)" }}>
                QR ishlamasa telefon raqam bilan ulaning. API maʼlumotlari allaqachon saqlangan —
                ularga tegish shart emas.
              </p>

              <label className="field">
                <span>Telefon raqam</span>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+998901234567"
                  autoComplete="off"
                />
              </label>

              <button
                type="button"
                className="btn ghost block"
                onClick={async () => {
                  try {
                    // QR kutayotgan boʻlsa uni toʻxtatamiz — ikkala oqim
                    // birga ketsa server ularning birini rad etadi.
                    qrSession.current?.();
                    await client.post(ENDPOINTS.TELEGRAM.CONNECT, { phone });
                    load();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Kod yuborish
              </button>

              {tg?.status === "awaiting_code" && (
                <div className="row" style={{ marginTop: "var(--gap-12)" }}>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Telegramdan kelgan kod"
                    style={{ flex: 1, minWidth: 160 }}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      await client.post(ENDPOINTS.TELEGRAM.CODE, { code });
                      setCode("");
                      load();
                    }}
                  >
                    Tasdiqlash
                  </button>
                </div>
              )}

              {tg?.status === "awaiting_password" && (
                <div className="row" style={{ marginTop: "var(--gap-12)" }}>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="2FA parol"
                    style={{ flex: 1, minWidth: 160 }}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      await client.post(ENDPOINTS.TELEGRAM.PASSWORD, { password });
                      setPassword("");
                      load();
                    }}
                  >
                    Kirish
                  </button>
                </div>
              )}

              {tg?.lastError && (
                <p className="hint" style={{ color: "var(--color-danger-text)", marginTop: "var(--gap-8)" }}>
                  {tg.lastError}
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Agent xulqi" icon={TbSettings}>
        <div className="grid c2">
          {FIELDS.map(([key, label, kind, hint]) => (
            <label key={key} className="field">
              <span>{label}</span>
              {kind === "bool" ? (
                <select
                  value={String(val(key)) === "1" ? "1" : "0"}
                  onChange={(e) => setDirty({ ...dirty, [key]: e.target.value })}
                >
                  <option value="1">Yoqilgan</option>
                  <option value="0">Oʻchirilgan</option>
                </select>
              ) : (
                <input
                  type={kind === "num" ? "number" : "text"}
                  value={val(key)}
                  onChange={(e) => setDirty({ ...dirty, [key]: e.target.value })}
                />
              )}
              {hint && <small>{hint}</small>}
            </label>
          ))}
        </div>
      </Card>

    </>
  );
}
