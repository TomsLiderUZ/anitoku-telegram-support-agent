/**
 * Navigation.
 *
 * The old panel had seventeen entries, several of which showed almost the same
 * thing. Related pages are merged here into eight, grouped by what you are
 * trying to do: watch the agent, direct it, teach it, configure it.
 */
import { NavLink } from 'react-router-dom';
import {
  FiActivity,
  FiCpu,
  FiDatabase,
  FiFolder,
  FiList,
  FiMessageSquare,
  FiSend,
  FiSettings,
  FiTerminal,
} from 'react-icons/fi';
import styles from './Sidebar.module.css';

const GROUPS = [
  {
    title: 'Kuzatuv',
    items: [
      { to: '/', end: true, label: 'Boshqaruv', icon: FiActivity },
      { to: '/chats', label: 'Suhbatlar', icon: FiMessageSquare, badge: 'escalations' },
    ],
  },
  {
    title: 'Boshqarish',
    items: [
      { to: '/assistant', label: 'Buyruq berish', icon: FiSend },
      { to: '/tasks', label: 'Vazifalar', icon: FiList, badge: 'tasks' },
      { to: '/projects', label: 'Loyihalar', icon: FiFolder },
      { to: '/code', label: 'Kod', icon: FiTerminal },
    ],
  },
  {
    title: 'Bilim',
    items: [{ to: '/knowledge', label: 'Bilim va oʻqitish', icon: FiDatabase }],
  },
  {
    title: 'Tizim',
    items: [
      { to: '/models', label: 'AI modellar', icon: FiCpu },
      { to: '/settings', label: 'Sozlamalar', icon: FiSettings },
    ],
  },
];

export default function Sidebar({ badges = {}, brand }) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <div className={styles.mark}>A</div>
        <div>
          <div className={styles.name}>{brand?.name || 'ANITOKU'}</div>
          <div className={styles.sub}>Agent boshqaruvi</div>
        </div>
      </div>

      <nav className={styles.nav}>
        {GROUPS.map((g) => (
          <div key={g.title} className={styles.group}>
            <div className={styles.groupTitle}>{g.title}</div>
            {g.items.map((it) => {
              const count = it.badge ? badges[it.badge] : 0;
              return (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end}
                  className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`}
                >
                  <it.icon size={16} />
                  <span>{it.label}</span>
                  {count > 0 && <span className={styles.count}>{count}</span>}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
