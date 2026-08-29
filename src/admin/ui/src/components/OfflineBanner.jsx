import { useEffect, useState } from "react";
import Asset from "@asset";

/**
 * OfflineBanner — internet aloqasi yo'qolganda ko'rinadigan ogohlantirish.
 *
 * Ilova (Service Worker tufayli) offline'da ham ochiladi, lekin
 * ma'lumotlar yangilanmaydi — foydalanuvchi buni bilishi kerak, aks
 * holda eski ekranni "hozirgi holat" deb o'ylaydi.
 *
 * Uch holatli: hidden → visible → leaving → hidden.
 * "leaving" bosqichi kerak, chunki komponent darhol unmount bo'lsa
 * yo'qolish animatsiyasi umuman ko'rinmay qolardi.
 */

// globals.css dagi .offline-banner.is_leaving animatsiyasi bilan mos
// bo'lishi shart (--duration-fast = 0.15s)
const EXIT_DURATION_MS = 150;

const OfflineBanner = () => {
  const [state, setState] = useState(() => (navigator.onLine ? "hidden" : "visible"));

  useEffect(() => {
    const goOffline = () => setState("visible");
    const goOnline = () => setState((prev) => (prev === "visible" ? "leaving" : "hidden"));

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Chiqib ketish animatsiyasi tugagach komponentni olib tashlaymiz
  useEffect(() => {
    if (state !== "leaving") return;

    const timer = setTimeout(() => setState("hidden"), EXIT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [state]);

  if (state === "hidden") return null;

  return (
    <div
      className={`offline-banner${state === "leaving" ? " is_leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      {/* O'lcham CSS'dan (--size-icon-sm, tor ekranda --size-icon-xs) —
          bu yerda width/height berilsa, Asset.Icon uni inline style qilib
          qo'yadi va CSS'ni bosib ketadi (18px lenta ichida 80px ikonka). */}
      <div className="offline-banner__icon" aria-hidden="true">
        <Asset.Icon name="wifi-off" fill="var(--color-accent)" width="100%" height="100%" stroke="0"/>
      </div>

      {/* Mobil ekranda tafsilot qismi CSS orqali yashiriladi (globals.css)
          — shunda matn bitta qatorga sig'adi va banner "tabletka" shaklini
          yo'qotmaydi. Ikki qatorga o'ralgan pill radiusi xunuk ko'rinardi. */}
      <span className="offline-banner__text">
        Internet aloqasi yo'q
        <span className="offline-banner__detail"> — ma'lumotlar yangilanmaydi</span>
      </span>
    </div>
  );
};

export default OfflineBanner;
