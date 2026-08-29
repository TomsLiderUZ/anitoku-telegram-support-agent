import { useEffect } from "react";
import { TbAlertTriangle, TbInbox, TbTrendingDown, TbTrendingUp, TbX } from "react-icons/tb";
import styles from "./index.module.scss";
import { trend as fmtTrend } from "../../utils/format";

/**
 * Panelning qayta ishlatiladigan bo'laklari.
 *
 * Bitta faylda, chunki ular birga o'zgaradi: Card ichida Badge,
 * Badge yonida Stat turadi va ularning oraliqlari kelishilgan bo'lishi
 * kerak. Har birini alohida papkaga bo'lsak, kelishuv ko'rinmay
 * qolardi.
 */

/* ── Card ───────────────────────────────────── */
export function Card({ title, icon: Icon, actions, children, className = "" }) {
  return (
    <section className={`${styles.card} ${className}`}>
      {(title || actions) && (
        <header className={styles.cardHead}>
          {Icon && <Icon size={16} className={styles.cardIcon} />}
          {title && <h2 className={styles.cardTitle}>{title}</h2>}
          {actions && <div className={styles.cardActions}>{actions}</div>}
        </header>
      )}
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

/* ── Stat ─────────────────────────────────────
   Bitta raqam + izoh + o'zgarish. `trend` — kechagi kunga nisbatan
   foiz; u BO'LMASA umuman ko'rsatilmaydi. "0%" bilan "ma'lumot yo'q"
   bir xil ko'rinmasligi kerak. */
export function Stat({ label, value, sub, tone = "", trend }) {
  const t = fmtTrend(trend);
  const up = Number(trend) > 0;

  return (
    <div className={`${styles.stat} ${tone ? styles[`tone_${tone}`] : ""}`}>
      <p className={styles.statLabel}>{label}</p>
      <p className={styles.statValue}>
        {value}
        {t && (
          <span className={`${styles.statTrend} ${up ? styles.trendUp : styles.trendDown}`}>
            {up ? <TbTrendingUp size={13} /> : <TbTrendingDown size={13} />}
            {t}
          </span>
        )}
      </p>
      {sub && <p className={styles.statSub}>{sub}</p>}
    </div>
  );
}

/* ── Badge ──────────────────────────────────── */
export function Badge({ tone = "", pulse = false, children }) {
  return (
    <span className={`${styles.badge} ${tone ? styles[`badge_${tone}`] : ""} ${pulse ? styles.badgePulse : ""}`}>
      {children}
    </span>
  );
}

/* ── Meter ────────────────────────────────────
   Nisbatni ko'rsatadigan chiziq. Raqamning o'zi yetarli emas:
   "3/12" ni o'qib chiqish kerak, chiziqning uzunligi esa bir
   qarashda ko'rinadi. */
export function Meter({ label, value = 0, max = 1, tone = "", right }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span>{label}</span>
        <span className={styles.meterRight}>{right ?? `${Math.round(pct)}%`}</span>
      </div>
      <div className={styles.meterTrack}>
        {/* Kenglik o'zgarganda siljib boradi — sakrab emas */}
        <div
          className={`${styles.meterFill} ${tone ? styles[`tone_${tone}`] : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ── Sahifa sarlavhasi ────────────────────────
   Navbar sahifa nomini allaqachon ko'rsatadi, shuning uchun bu yerda
   sarlavha TAKRORLANMAYDI — faqat bo'limga tegishli tugmalar.
   `title` berilsa u ichki bo'lim sarlavhasi sifatida ishlaydi. */
export function PageHead({ title, desc, children }) {
  return (
    <div className={styles.pageHead}>
      {(title || desc) && (
        <div className={styles.pageHeadText}>
          {title && <h2 className={styles.pageTitle}>{title}</h2>}
          {desc && <p className="hint">{desc}</p>}
        </div>
      )}
      {children && <div className={styles.pageHeadActions}>{children}</div>}
    </div>
  );
}

/* ── Bo'sh holat ────────────────────────────── */
export function Empty({ icon: Icon = TbInbox, children }) {
  return (
    <div className={styles.empty}>
      <Icon size={26} />
      <p>{children || "Hozircha maʼlumot yoʻq"}</p>
    </div>
  );
}

/* ── Yuklanmoqda ──────────────────────────────
   Aylanayotgan g'ildirak emas, skeleton: joyning shakli oldindan
   ko'rinsa, ma'lumot kelganda sahifa "sakramaydi". */
export function Loading({ rows = 3 }) {
  return (
    <div className={styles.loading}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`skeleton ${styles.loadingRow}`} style={{ "--i": i }} />
      ))}
    </div>
  );
}

/* ── Modal ────────────────────────────────────
   Bitta narsani to'liq ko'rish yoki tahrirlash uchun. Ro'yxat orqada
   turadi — foydalanuvchi qayerdan kelganini unutmaydi va yopgach
   o'sha joyiga qaytadi. */
export function Modal({ open, title, onClose, actions, children }) {
  // Escape bilan yopiladi va varaq ortidagi sahifa surilmaydi.
  // Ikkalasi ham "modal" degan so'zning ma'nosiga kiradi: u ochiq
  // ekan, diqqat faqat unda bo'lishi kerak.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.modalWrap} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.modalOverlay} onClick={onClose} role="presentation" />

      <div className={styles.modal}>
        <header className={styles.modalHead}>
          <h2 className={styles.modalTitle}>{title}</h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Yopish">
            <TbX size={15} />
          </button>
        </header>

        <div className={styles.modalBody}>{children}</div>

        {actions && <footer className={styles.modalFoot}>{actions}</footer>}
      </div>
    </div>
  );
}

/* ── Xato ───────────────────────────────────── */
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;

  return (
    <div className={styles.error} role="alert">
      <TbAlertTriangle size={17} />
      <span>{error.message || String(error)}</span>
      {onRetry && (
        <button type="button" className="btn ghost sm" onClick={onRetry}>
          Qayta urinish
        </button>
      )}
    </div>
  );
}
