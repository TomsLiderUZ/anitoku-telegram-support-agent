/**
 * Small building blocks used across every page.
 *
 * They exist so a page reads as its own content rather than as markup: a stat
 * card, a section, a state pill, an empty state. Anything used twice lands
 * here; anything used once stays in its page.
 */
import { FiAlertCircle, FiInbox, FiLoader, FiTrendingDown, FiTrendingUp } from 'react-icons/fi';
import styles from './Ui.module.css';

export function Card({ title, icon: Icon, actions, children, className = '', ...rest }) {
  return (
    <section className={`card ${className}`} {...rest}>
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <h3 className="card-title">
              {Icon && <Icon size={16} />}
              {title}
            </h3>
          )}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * A headline number with its own trend. The trend is the point: "95 replies"
 * says little, "95, down 14% on yesterday" says something worth acting on.
 */
export function Stat({ label, value, sub, trend, tone = '' }) {
  const up = typeof trend === 'number' && trend > 0;
  const down = typeof trend === 'number' && trend < 0;
  return (
    <div className={`${styles.stat} ${tone ? styles[tone] : ''}`}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statSub}>
        {typeof trend === 'number' && trend !== 0 && (
          <span className={`${styles.trend} ${up ? styles.up : down ? styles.down : ''}`}>
            {up ? <FiTrendingUp size={12} /> : <FiTrendingDown size={12} />}
            {Math.abs(trend)}%
          </span>
        )}
        {sub}
      </div>
    </div>
  );
}

export function Badge({ tone = '', children, pulse = false }) {
  return (
    <span className={`badge ${tone}`}>
      {pulse && <span className="dot pulse" />}
      {children}
    </span>
  );
}

export function Empty({ children = 'Maʼlumot yoʻq', icon: Icon = FiInbox }) {
  return (
    <div className="empty">
      <Icon size={22} style={{ display: 'block', margin: '0 auto 8px', opacity: 0.5 }} />
      {children}
    </div>
  );
}

export function Loading({ label = 'Yuklanmoqda…' }) {
  return (
    <div className="empty">
      <FiLoader size={20} className={styles.spin} style={{ display: 'block', margin: '0 auto 8px' }} />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className={styles.error}>
      <FiAlertCircle size={16} />
      <span>{String(error.message || error)}</span>
      {onRetry && (
        <button type="button" className="btn ghost sm" onClick={onRetry}>
          Qayta urinish
        </button>
      )}
    </div>
  );
}

export function PageHead({ title, desc, children }) {
  return (
    <header className={styles.pageHead}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {desc && <p className={styles.pageDesc}>{desc}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </header>
  );
}

/** A labelled bar — used where a chart would be overkill (key health, quotas). */
export function Meter({ label, value, max, tone = 'accent', right }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={styles.meter}>
      <div className={styles.meterTop}>
        <span>{label}</span>
        <span className={styles.meterVal}>{right ?? `${value}/${max}`}</span>
      </div>
      <div className={styles.meterTrack}>
        <div className={`${styles.meterFill} ${styles[tone]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
