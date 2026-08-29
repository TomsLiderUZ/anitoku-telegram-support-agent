import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import styles from "./index.module.scss";
import Asset from "@asset";
import AdminService from "../../api/services/authService";
import { preloadRouteByPath } from "../../router/routes";

/**
 * Kirish sahifasi.
 *
 * Dizayn dodakino'dan (chapda forma, o'ngda illyustratsiya), lekin
 * "Telegram orqali kirish" olib tashlangan: bizda admin faqat nom va
 * parol bilan kiradi. Telegram esa agentning O'Z akkaunti — u
 * Sozlamalar bo'limida ulanadi va bu tamoman boshqa narsa. Ikkalasini
 * bir ekranda ko'rsatish "qaysi akkaunt bilan kiryapman?" degan
 * chalkashlikni tug'dirardi.
 */
function Auth() {
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Login muvaffaqiyatli bo'lsa keyingi manzil aniq — dashboard.
    // Uni hozirdanoq fonda yuklab qo'yamiz: navigate() paytida chunk
    // tayyor bo'ladi va o'tish kechikishsiz sodir bo'ladi.
    preloadRouteByPath("/dashboard");
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    const formData = new FormData(e.target);

    try {
      await AdminService.login(
        {
          username: formData.get("username"),
          password: formData.get("password"),
        },
        formData.get("rememberMe") === "on"
      );

      // Foydalanuvchi qaysi sahifaga kirmoqchi bo'lgan bo'lsa —
      // o'shanga qaytadi, aks holda boshqaruv paneliga.
      const from = location.state?.from;
      navigate(from && from !== "/auth" ? from : "/dashboard", { replace: true });
    } catch (err) {
      setError(err?.message || "Login yoki parol notoʻgʻri. Qaytadan urinib koʻring.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className={styles.wrapper}>
      <section className={styles.container} aria-labelledby="login-title" aria-describedby="login-description">
        <div className={styles.left}>
          <header className={styles.top}>
            <h1 id="login-title" className={styles.title}>
              Tizimga kirish
            </h1>

            <p id="login-description" className={styles.text}>
              ANITOKU agentining boshqaruv paneli. Davom etish uchun administrator nomi va parolini kiriting.
            </p>
          </header>

          <form
            className={styles.form}
            onSubmit={handleSubmit}
            aria-label="Administrator tizimiga kirish formasi"
            noValidate
          >
            {error && (
              <div className={styles.error_message} role="alert">
                <Asset.Icon
                  name="info"
                  fill={"var(--color-danger-text)"}
                  className={styles.error_icon}
                  aria-hidden="true"
                />
                <span className={styles.error_text}>{error}</span>
              </div>
            )}

            <div className={styles.form_container}>
              <label htmlFor="username" className={styles.input_label}>
                <Asset.Icon
                  name="user"
                  className={styles.icon}
                  aria-hidden="true"
                  fill={"transparent"}
                  stroke={"2px solid var(--color-text-secondary)"}
                />
                <span className={styles.text}>Administrator nomi</span>
                <input
                  id="username"
                  name="username"
                  type="text"
                  className={styles.input}
                  placeholder=" "
                  autoComplete="username"
                  required
                  aria-required="true"
                />
              </label>

              <label htmlFor="password" className={styles.input_label}>
                <span className={styles.text}>Administrator paroli</span>
                <Asset.Icon
                  name="lock"
                  className={styles.icon}
                  aria-hidden="true"
                  fill={"transparent"}
                  stroke={"0.7px solid var(--color-text-secondary)"}
                />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  className={styles.input}
                  placeholder=" "
                  autoComplete="current-password"
                  required
                  aria-required="true"
                />
                <button
                  type="button"
                  className={styles.button}
                  // onMouseDown → preventDefault: usiz tugmani bosganda
                  // input fokusni yo'qotardi va suzuvchi yorliq
                  // (floating label) bir lahzaga sakrab tushardi.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault();
                    setShowPassword((prev) => !prev);
                  }}
                  aria-label={showPassword ? "Parolni yashirish" : "Parolni koʻrsatish"}
                >
                  {showPassword ? (
                    <Asset.Icon
                      name="eye"
                      className={styles.eye}
                      aria-hidden="true"
                      focusable="false"
                      fill={"var(--color-text-muted)"}
                    />
                  ) : (
                    <Asset.Icon
                      name="eye-slash"
                      className={styles.eye}
                      aria-hidden="true"
                      focusable="false"
                      width={"20px"}
                      height={"20px"}
                      fill={"var(--color-text-muted)"}
                    />
                  )}
                </button>
              </label>

              <label htmlFor="rememberMe" className={styles.checkbox_label}>
                <input
                  id="rememberMe"
                  name="rememberMe"
                  type="checkbox"
                  className={styles.checkbox_input}
                  aria-label="Meni eslab qolish"
                  defaultChecked
                />
                <span className={styles.text}>Eslab qolish</span>
              </label>
            </div>

            <button
              type="submit"
              title="Tizimga kirish"
              className={styles.button}
              aria-label="Administrator sifatida tizimga kirish"
              disabled={isLoading}
            >
              {isLoading ? "Kirilmoqda..." : "Kirish"}
            </button>
          </form>
        </div>

        <aside className={styles.right} aria-hidden="true">
          <Asset.Icon name="ilustration-auth" className={styles.ilustration} aria-hidden="true" focusable="false" />
        </aside>
      </section>
    </main>
  );
}

export default Auth;
