import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { TbMoon, TbSun, TbPlayerPause, TbPlayerPlay, TbLogout, TbBolt } from "react-icons/tb";
import styles from "./index.module.scss";
import theme from "@theme";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";
import AdminService from "../../api/services/authService";
import { TokenManager } from "../../api/tokenManager";
import { findRouteByPath } from "../../router/routes";

/**
 * Navbar — sahifa nomi va butun panelga taalluqli uchta boshqaruv:
 * agentni to'xtatish, mavzu, chiqish.
 *
 * NEGA AYNAN SHU UCHTASI: navbar har sahifada ko'rinadi, demak unga
 * faqat "qayerda bo'lsam ham kerak bo'lishi mumkin" degan amallar
 * tushadi. Agentni shoshilinch to'xtatish — aynan shunday amal.
 */
function Navbar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const route = findRouteByPath(pathname);

  const [mode, setMode] = useState(() => theme.get().effective);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  // Mavzu boshqa joydan o'zgarsa (masalan tizim rejimi) tugma ham
  // yangilansin — holat ikki joyda saqlanmasin.
  useEffect(() => theme.subscribe((effective) => setMode(effective)), []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await client.get(ENDPOINTS.STATUS, { silent: true }));
    } catch {
      // Navbar ma'lumot ko'rsatuvchi emas — holat kelmasa shunchaki
      // ko'rsatkich yashirinadi, xato banneri chiqarilmaydi.
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 15_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const paused = Boolean(status?.paused ?? status?.agent?.paused);
  const admin = TokenManager.getUserFromToken();

  const togglePause = async () => {
    setBusy(true);
    try {
      await client.post(ENDPOINTS.AGENT_STATE, { paused: !paused });
      await loadStatus();
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await AdminService.logout();
    navigate("/auth", { replace: true });
  };

  return (
    <header className={styles.wrapper}>
      <div className={`layout-inner ${styles.inner}`}>
        <div className={styles.titleBox}>
          {/* Sarlavha route'dan olinadi: "Boshqaruv paneli | ANITOKU"
              dagi birinchi bo'lak. Sahifa o'zi yana bir bor yozmaydi —
              ikkalasi farq qilib qolishi mumkin bo'lmasin. */}
          <h1 className={styles.title}>{(route?.title || "").split("|")[0].trim()}</h1>
          <p className={styles.desc}>{route?.description}</p>
        </div>

        <div className={styles.actions}>
          {/* Agent holati — bosiladigan emas, ko'rsatkich */}
          <span className={`${styles.pill} ${paused ? styles.pillOff : styles.pillOn}`}>
            <TbBolt size={13} />
            {paused ? "toʻxtatilgan" : "ishlamoqda"}
          </span>

          <button
            type="button"
            className="btn ghost sm"
            onClick={togglePause}
            disabled={busy}
            title={paused ? "Agentni davom ettirish" : "Agentni vaqtincha to'xtatish"}
          >
            {paused ? <TbPlayerPlay size={15} /> : <TbPlayerPause size={15} />}
            <span className={styles.actionLabel}>{paused ? "Davom" : "Pauza"}</span>
          </button>

          <button
            type="button"
            className={`btn ghost sm ${styles.iconBtn}`}
            onClick={() => theme.set({ mode: mode === "dark" ? "light" : "dark" })}
            title={mode === "dark" ? "Yorugʻ mavzuga oʻtish" : "Tungi mavzuga oʻtish"}
            aria-label="Mavzuni almashtirish"
          >
            {/* Belgi aylanib almashadi — o'zgarish sezilsin */}
            <span className={styles.themeIcon} key={mode}>
              {mode === "dark" ? <TbSun size={15} /> : <TbMoon size={15} />}
            </span>
          </button>

          <button
            type="button"
            className={`btn ghost sm ${styles.iconBtn}`}
            onClick={logout}
            title={admin ? `${admin.username} — chiqish` : "Chiqish"}
            aria-label="Chiqish"
          >
            <TbLogout size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

export default Navbar;
