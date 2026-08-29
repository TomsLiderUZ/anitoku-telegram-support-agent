import { useEffect } from "react";

/**
 * SEO — sahifa title va meta teglarini boshqaradi.
 *
 * NEGA JSX EMAS, IMPERATIV DOM?
 * React 19 komponent ichida render qilingan <title>/<meta> teglarini
 * <head> ga ko'chiradi (hoisting), LEKIN index.html dagi mavjud statik
 * teglarni almashtirmaydi — ularning yoniga YANGISINI qo'shadi. Natijada
 * hujjatda ikkita <title> (va takroriy <meta>) paydo bo'ladi: HTML
 * qoidasiga zid, qidiruv tizimlari va ulashish (Telegram/Facebook)
 * uchun esa qaysi biri olinishi noaniq.
 *
 * Shuning uchun teglar DOM orqali yangilanadi: `document.title` va
 * `<meta>` larning `content` atributi MAVJUD teglarni tahrirlaydi,
 * yangisini yaratmaydi. Statik teg index.html da qoladi — JS yuklangunicha
 * ham to'g'ri sarlavha ko'rinadi.
 */

/** Mavjud <meta> ni yangilaydi; umuman bo'lmasa — bir marta yaratadi */
const setMeta = (attr, key, content) => {
  if (!content) return;

  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
};

/** <link rel="..."> ni yangilaydi; bo'lmasa yaratadi */
const setLink = (rel, href) => {
  if (!href) return;

  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
};

const SEO = ({ title, description, name, type }) => {
  useEffect(() => {
    // Spec bo'yicha `document.title` MAVJUD <title> ning matnini
    // o'zgartiradi (yangisini yaratmaydi) — aynan kerakli xatti-harakat.
    if (title) document.title = title;

    setMeta("name", "description", description);

    // Joriy sahifa manzili — index.html dagi statik og:url butun ilova
    // uchun bitta bo'lib qolardi, ulashishda esa har doim bosh sahifa
    // ko'rsatilardi. Ishlaydigan domen: apex (www DNS'da mavjud emas).
    const canonical = window.location.origin + window.location.pathname;

    // OpenGraph (Telegram, Facebook va h.k. ulashish uchun)
    setMeta("property", "og:type", type || "website");
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("property", "og:url", canonical);

    // Twitter Card
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:creator", name || "ANITOKU");
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);

    setLink("canonical", canonical);
  }, [title, description, name, type]);

  return null;
};

export default SEO;
