import { NavLink, useLocation } from "react-router-dom";
import { TbBolt } from "react-icons/tb";
import styles from "./index.module.scss";
import { navGroups, preloadRouteByPath } from "../../router/routes";

/**
 * Sidebar — asosiy navigatsiya (kompyuter va planshet).
 *
 * Bandlar `routes.js` dan olinadi, bu yerda ro'yxat QO'LDA
 * yozilmaydi: yangi bo'lim qo'shilganda menyuga qo'shishni unutish
 * mumkin bo'lmasin.
 *
 * NavLink ustiga sichqoncha kelishi bilan sahifa chunk'i fonda
 * yuklanadi (AppLink'dagi bilan bir xil hiyla) — bosilganda o'tish
 * kechikishsiz bo'ladi.
 */
function Sidebar() {
  const { pathname } = useLocation();

  return (
    <aside className={styles.wrapper}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          <TbBolt size={17} />
        </span>
        <span className={styles.brandText}>
          ANITOKU
          <small>agent paneli</small>
        </span>
      </div>

      <nav className={styles.nav}>
        {navGroups.map((group) => (
          <div key={group.title} className={styles.group}>
            <p className={styles.groupTitle}>{group.title}</p>

            {group.items.map(({ path, label, icon: Icon }, i) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) => `${styles.item} ${isActive ? styles.itemOn : ""}`}
                style={{ "--i": i }}
                onMouseEnter={() => preloadRouteByPath(path)}
                onFocus={() => preloadRouteByPath(path)}
              >
                <Icon size={18} className={styles.icon} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className={styles.foot}>
        {/* Qaysi bo'limdaligini pastda ham takrorlash ortiqcha —
            bu yer versiya uchun, u esa xato haqida gapirganda kerak. */}
        <span className="hint mono">v{process.env.REACT_APP_VERSION || "1.0.0"}</span>
        <span className={styles.crumb}>{pathname}</span>
      </div>
    </aside>
  );
}

export default Sidebar;
