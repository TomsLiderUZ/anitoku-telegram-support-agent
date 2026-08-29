/**
 * Top bar: whether the agent is actually working, and the controls you reach
 * for most often — pause, theme, sign out.
 *
 * The pause button is deliberately here rather than buried in settings: it is
 * the one control you want within reach when the agent misbehaves.
 */
import { useState } from 'react';
import { FiLogOut, FiMoon, FiPause, FiPlay, FiSun } from 'react-icons/fi';
import { api, logout } from '../api/client';
import { ThemeManager } from '../@theme/ThemeManager';
import { Badge } from './Ui';
import styles from './Navbar.module.css';

const TG_LABEL = {
  connected: ['Telegram ulangan', 'ok'],
  connecting: ['Ulanmoqda', 'info'],
  awaiting_qr: ['QR kutilmoqda', 'warn'],
  awaiting_code: ['Kod kutilmoqda', 'warn'],
  awaiting_password: ['Parol kutilmoqda', 'warn'],
  error: ['Telegram xatosi', 'danger'],
  disconnected: ['Telegram ulanmagan', 'danger'],
};

export default function Navbar({ status, onChanged }) {
  const [theme, setTheme] = useState(ThemeManager.get());
  const [busy, setBusy] = useState(false);

  const paused = status?.agent?.paused;
  const tg = status?.telegram?.status || 'disconnected';
  const [tgLabel, tgTone] = TG_LABEL[tg] || [tg, ''];

  const togglePause = async () => {
    setBusy(true);
    try {
      await api.post('/agent/state', { paused: !paused });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className={styles.navbar}>
      <div className="row">
        <Badge tone={paused ? 'warn' : 'ok'} pulse={!paused}>
          {paused ? 'Pauzada' : 'Faol'}
        </Badge>
        <Badge tone={tgTone}>{tgLabel}</Badge>
        {status?.agent?.queued > 0 && <Badge tone="info">{status.agent.queued} navbatda</Badge>}
      </div>

      <div className="spacer" />

      <button type="button" className="btn ghost sm" onClick={togglePause} disabled={busy}>
        {paused ? <FiPlay size={14} /> : <FiPause size={14} />}
        {paused ? 'Davom ettirish' : 'Pauza'}
      </button>

      <button
        type="button"
        className="btn ghost sm"
        title={theme === 'dark' ? 'Kunduzgi rejim' : 'Tungi rejim'}
        onClick={() => setTheme(ThemeManager.toggle())}
      >
        {theme === 'dark' ? <FiSun size={14} /> : <FiMoon size={14} />}
      </button>

      <button type="button" className="btn ghost sm" onClick={logout} title="Chiqish">
        <FiLogOut size={14} />
      </button>
    </header>
  );
}
