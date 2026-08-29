/**
 * App shell: fixed rail, sticky top bar, scrolling content.
 *
 * Agent status is fetched here and passed down, so every page shares one poll
 * instead of each one hitting /api/status on its own schedule.
 */
import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Navbar from '../components/Navbar';
import { api, onLoading } from '../api/client';
import styles from './index.module.css';

export default function MainLayout() {
  const [status, setStatus] = useState(null);
  const [badges, setBadges] = useState({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/status', { silent: true });
      setStatus(s);
      setBadges({ escalations: s.agent?.openEscalations || 0, tasks: 0 });
    } catch {
      /* a failed poll must not blank the shell */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => onLoading(setLoading), []);

  return (
    <div className={styles.wrapper}>
      <Sidebar badges={badges} brand={status?.brand} />
      <div className={styles.main}>
        <div className={`${styles.progress} ${loading ? styles.on : ''}`} />
        <Navbar status={status} onChanged={refresh} />
        <main className={styles.content}>
          <Outlet context={{ status, refresh }} />
        </main>
      </div>
    </div>
  );
}
