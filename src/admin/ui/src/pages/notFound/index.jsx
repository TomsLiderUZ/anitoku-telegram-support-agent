import styles from "./index.module.scss";
import AppLink from "../../components/AppLink";
import { TokenManager } from "../../api/tokenManager";

/**
 * 404 — mavjud bo'lmagan manzil. Layout'siz (standalone) render qilinadi,
 * shuning uchun o'zi to'liq ekranni egallaydi.
 */
function NotFoundPage() {
  // Kirmagan foydalanuvchini dashboard'ga yuborish ma'nosiz — u baribir
  // /auth ga qaytariladi
  const home = TokenManager.hasAccessToken() ? "/dashboard" : "/auth";

  return (
    <main className={styles.wrapper}>
      <section className={styles.container}>
        <p className={styles.code} aria-hidden="true">404</p>

        <h1 className={styles.title}>Sahifa topilmadi</h1>

        <p className={styles.text}>
          Bu manzilda hech narsa yo'q — havola eskirgan yoki noto'g'ri
          yozilgan bo'lishi mumkin.
        </p>

        <AppLink to={home} className={styles.button}>
          {home === "/dashboard" ? "Boshqaruv paneliga qaytish" : "Kirish sahifasiga o'tish"}
        </AppLink>
      </section>
    </main>
  );
}

export default NotFoundPage;
