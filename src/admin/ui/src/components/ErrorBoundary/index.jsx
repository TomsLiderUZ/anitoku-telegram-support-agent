import { Component } from "react";
import NProgress from "../../utils/progress";

/**
 * ErrorBoundary — komponent xatolarida oq ekran o'rniga chiroyli
 * fallback ko'rsatadi.
 *
 * Nega class? React'da error boundary FAQAT class komponent bo'la oladi
 * (getDerivedStateFromError/componentDidCatch hook varianti yo'q).
 *
 * Ikki xil xato ajratiladi:
 *  1. Chunk yuklanish xatosi (lazy sahifa fayli kelmadi — internet uzildi
 *     yoki yangi deploy'dan keyin eski chunk 404 bo'ldi) → to'liq reload
 *     kerak, chunki eski chunk endi serverda yo'q bo'lishi mumkin.
 *  2. Oddiy render xatosi → state tozalanadi va React o'sha joyni
 *     qayta render qilib ko'radi (sahifaning qolgani ishlayveradi).
 */
const isChunkLoadError = (error) =>
  error?.name === "ChunkLoadError" ||
  /Loading (CSS )?chunk [\w-]+ failed/i.test(error?.message || "") ||
  /Failed to fetch dynamically imported module/i.test(error?.message || "");

class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Sahifa chizilmadi — PageTransition mount bo'lmaydi, demak
    // yuklanish chizig'ini shu yerda yakunlash kerak (aks holda u
    // ekranda abadiy qolib ketardi).
    NProgress.done();

    // Kelajakda bu yerga Sentry kabi monitoring ulash mumkin
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  handleRetry = () => {
    if (isChunkLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // DIQQAT: bu yerda "internet yo'q" uchun ALOHIDA ekran YO'Q — ataylab.
    // Aloqa uzilganda foydalanuvchi pastdagi OfflineBanner'ni ko'radi va
    // sahifasida qolaveradi; hali yuklanmagan sahifani ochsa quyidagi
    // "Sahifa yuklanmadi" fallback'i chiqadi, uning tugmasi esa reload
    // qiladi — o'shanda Service Worker o'zining offline ekranini beradi.
    const chunkError = isChunkLoadError(error);

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          minHeight: "50vh",
          padding: "32px 20px",
          textAlign: "center",
          fontFamily: "var(--font-inter, sans-serif)",
          color: "var(--color-text-primary, #1a1a18)",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: "40px", lineHeight: 1 }}>
          {chunkError ? "📡" : "⚠️"}
        </span>

        <h2 style={{ fontSize: "20px", fontWeight: 700 }}>
          {chunkError ? "Sahifa yuklanmadi" : "Kutilmagan xatolik yuz berdi"}
        </h2>

        <p style={{ maxWidth: "420px", opacity: 0.75, fontSize: "14px", lineHeight: 1.6 }}>
          {chunkError
            ? "Internet aloqangizni tekshirib, sahifani qayta yuklang. Agar yaqinda yangilanish chiqqan bo'lsa, qayta yuklash muammoni hal qiladi."
            : "Bu bo'limda texnik nosozlik yuz berdi. Qayta urinib ko'ring — sahifaning qolgan qismi ishlashda davom etmoqda."}
        </p>

        <button
          type="button"
          onClick={this.handleRetry}
          style={{
            marginTop: "8px",
            padding: "10px 24px",
            borderRadius: "8px",
            border: "none",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 600,
            // CTA tugma → --color-accent (--color-brand faqat logo/marketing uchun)
            background: "var(--color-accent, #d7ff22)",
            color: "var(--color-text-on-accent, #14150a)",
          }}
        >
          {chunkError ? "Sahifani qayta yuklash" : "Qayta urinish"}
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
