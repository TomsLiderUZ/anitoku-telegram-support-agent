const STORAGE_KEY = "theme";
const EVENT_NAME = "themechange";
const VALID_MODES = ["light", "dark", "auto"];

class ThemeManager {
  constructor() {
    this._mode = this._readStoredMode();
    this._animation = true;
    this._pendingTransition = null;
    this._mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this._reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this._listeners = new Set();

    // Agar localStorage'da umuman qiymat bo'lmasa, "auto"ni yozib qo'yamiz
    if (!localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, this._mode);
    }

    // Tizim mavzusi o'zgarsa (auto rejimda) qayta render qilish
    this._mediaQuery.addEventListener("change", () => {
      if (this._mode === "auto") this._applyTheme();
    });

    // Boshqa komponentlardan kelgan o'zgarishlarni tinglash.
    // MUHIM: set() ham xuddi shu eventni dispatch qiladi — agar bu yerda
    // shartsiz qayta _applyTheme() chaqirilsa, set() boshlagan View
    // Transition animatsiyasi darhol skip qilinib, theme almashinuvi
    // animatsiyasiz "sakrab" o'tardi. Shuning uchun faqat mode HAQIQATAN
    // o'zgargan bo'lsagina qayta qo'llaymiz (o'z eventimiz no-op bo'ladi).
    window.addEventListener(EVENT_NAME, () => {
      const stored = this._readStoredMode();
      if (stored !== this._mode) {
        this._mode = stored;
        this._applyTheme();
      }
    });

    // Boshqa tablardan kelgan o'zgarishlarni tinglash
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) {
        const stored = this._readStoredMode();
        if (stored !== this._mode) {
          this._mode = stored;
          this._applyTheme();
        }
      }
    });

    // Birinchi yuklanishda animatsiyasiz qo'llash
    this._applyTheme({ skipAnimation: true });
  }

  // Sukut "auto" EMAS, "dark" — panel ataylab tungi mavzuda ochiladi.
  // Kun bo'yi ochiq turadigan boshqaruv ekrani uchun qorong'i fon
  // kamroq charchatadi, grafiklar esa unda aniqroq ajraladi. Tizim
  // yorug' rejimda bo'lsa ham panel qorong'i qoladi; foydalanuvchi
  // navbardagi tugma bilan istagan rejimga o'tadi va tanlovi
  // localStorage'da saqlanadi.
  _readStoredMode() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return VALID_MODES.includes(stored) ? stored : "dark";
  }

  _resolveEffectiveMode() {
    if (this._mode === "auto") {
      return this._mediaQuery.matches ? "dark" : "light";
    }
    return this._mode;
  }

  _applyTheme({ skipAnimation = false } = {}) {
    const root = document.documentElement;
    const effective = this._resolveEffectiveMode();

    const applyClasses = () => {
      root.classList.remove("light", "dark");
      root.classList.add(effective);
      root.style.colorScheme = effective;
      
      // Qiymatlar src/styles/colors.css dagi --color-bg-primary bilan
      // bir xil bo'lishi SHART (public/index.html dagi inline skriptda ham)
      const metaThemeColor = document.querySelector('meta[name="theme-color"]');
      if (metaThemeColor) {
        metaThemeColor.setAttribute("content", effective === "dark" ? "#0b0d12" : "#f3f4f8");
      }
    };

    const canAnimate =
      !skipAnimation &&
      this._animation &&
      !this._reducedMotionQuery.matches &&
      document.startViewTransition &&
      document.visibilityState === "visible";

    if (canAnimate) {
      // Oldingi tugallanmagan transition bo'lsa, darhol o'tkazib yuborish
      if (this._pendingTransition) {
        this._pendingTransition.skipTransition?.();
      }
      this._pendingTransition = document.startViewTransition(() => applyClasses());
      this._pendingTransition.finished
        .catch(() => {})
        .finally(() => {
          this._pendingTransition = null;
        });
    } else {
      applyClasses();
    }

    this._listeners.forEach((cb) => cb(effective, this._mode));
  }

  /**
   * @param {{mode?: "light"|"dark"|"auto", animation?: boolean}} options
   */
  set({ mode, animation } = {}) {
    if (mode !== undefined) {
      if (!VALID_MODES.includes(mode)) {
        console.warn(
          `[theme] Noto'g'ri mode: "${mode}". Ruxsat etilgan: ${VALID_MODES.join(", ")}`
        );
      } else {
        this._mode = mode;
        localStorage.setItem(STORAGE_KEY, mode);
      }
    }

    if (animation !== undefined) {
      this._animation = animation;
    }

    this._applyTheme();

    window.dispatchEvent(new Event(EVENT_NAME));
  }

  get() {
    return {
      mode: this._mode,
      effective: this._resolveEffectiveMode(),
      animation: this._animation,
    };
  }

  subscribe(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }
}

const theme = new ThemeManager();
export default theme;