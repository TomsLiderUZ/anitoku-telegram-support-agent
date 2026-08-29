import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { TbDots, TbX } from "react-icons/tb";
import styles from "./index.module.scss";
import { navGroups, tabbarItems } from "../../router/routes";

/**
 * Tabbar — mobil navigatsiya (1024px dan tor ekran).
 *
 * NEGA TABBAR, "GAMBURGER" EMAS: telefonda barmoq ekranning pastida
 * turadi. Yuqori chap burchakdagi menyu tugmasiga yetish uchun
 * qurilmani qo'lda surish kerak. Panelning kundalik ishida bo'lim
 * o'nlab marta almashadi — har safar shu harakat qilinmasin.
 *
 * Bo'limlar sakkizta, tabbarga esa beshtasi sig'adi (undan ko'pi tegish
 * maydonini 44px dan kichraytiradi). Shuning uchun eng ko'p
 * ochiladiganlari tabbarda, qolganlari "Yana" varag'ida.
 */
function Tabbar() {
  const { pathname } = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Sahifa almashsa varaq o'zi yopiladi — aks holda o'tgandan keyin
  // ham ekranni yopib turardi.
  useEffect(() => setSheetOpen(false), [pathname]);

  // Varaq ochiq turganda ortidagi sahifa suriladigan bo'lib qolmasin
  useEffect(() => {
    if (!sheetOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheetOpen]);

  // Escape bilan yopish — klaviatura ulangan planshetda ham ishlasin
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e) => e.key === "Escape" && setSheetOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  return (
    <>
      {sheetOpen && (
        <div
          className={styles.overlay}
          onClick={() => setSheetOpen(false)}
          role="presentation"
        />
      )}

      <div className={`${styles.sheet} ${sheetOpen ? styles.sheetOpen : ""}`} aria-hidden={!sheetOpen}>
        <div className={styles.sheetHead}>
          <strong>Barcha boʻlimlar</strong>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setSheetOpen(false)}
            aria-label="Yopish"
          >
            <TbX size={15} />
          </button>
        </div>

        {navGroups.map((group) => (
          <div key={group.title} className={styles.sheetGroup}>
            <p className={styles.sheetGroupTitle}>{group.title}</p>
            {group.items.map(({ path, label, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) =>
                  `${styles.sheetItem} ${isActive ? styles.sheetItemOn : ""}`
                }
                tabIndex={sheetOpen ? 0 : -1}
              >
                <Icon size={18} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </div>

      <nav className={styles.wrapper} aria-label="Asosiy menyu">
        {tabbarItems.map(({ path, label, short, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabOn : ""}`}
          >
            <Icon size={19} />
            <span>{short || label}</span>
          </NavLink>
        ))}

        <button
          type="button"
          className={`${styles.tab} ${sheetOpen ? styles.tabOn : ""}`}
          onClick={() => setSheetOpen((v) => !v)}
          aria-expanded={sheetOpen}
        >
          <TbDots size={19} />
          <span>Yana</span>
        </button>
      </nav>
    </>
  );
}

export default Tabbar;
