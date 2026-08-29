import { useEffect, useState } from "react";
import styles from "./index.module.scss";
import client from "../../api/client";
import { ENDPOINTS } from "../../api/endpoints";

/**
 * Footer — panelning eng past qatori.
 *
 * Bu yerda reklama yoki havolalar yo'q: ichki asbob uchun ular
 * shovqin. Faqat "server tirikmi va qachondan beri ishlayapti" —
 * nosozlikni tekshirish har doim shu savoldan boshlanadi.
 */
function Footer() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const load = () =>
      client
        .get(ENDPOINTS.HEALTH, { baseURL: "", silent: true })
        .then(setHealth)
        .catch(() => setHealth(null));

    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const uptime = health?.uptimeSec ? formatUptime(health.uptimeSec) : null;

  return (
    <footer className={styles.wrapper}>
      <div className={`layout-inner ${styles.inner}`}>
        <span className={styles.dotRow}>
          <span className={`${styles.dot} ${health?.ok ? styles.dotOk : styles.dotBad}`} />
          {health ? (health.ok ? "Tizim ishlamoqda" : "Tizimda nosozlik") : "Aloqa yoʻq"}
        </span>

        {uptime && <span className={styles.meta}>{uptime} ishlayapti</span>}

        <span className="spacer" />

        <span className={styles.meta}>ANITOKU agent</span>
      </div>
    </footer>
  );
}

/** Soniyani odam o'qiydigan ko'rinishga o'giradi ("3 kun 4 soat"). */
function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} kun ${h} soat`;
  if (h) return `${h} soat ${m} daqiqa`;
  return `${m} daqiqa`;
}

export default Footer;
