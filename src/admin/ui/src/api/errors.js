/**
 * ============================================
 * ANITOKU — API Error Class
 * ============================================
 *
 * Barcha API xatoliklarini yagona formatga keltiradi.
 * Senior approach: Axios error, network error, server error —
 * hammasi bir xil interface ga ega bo'ladi.
 */

export class ApiError extends Error {
  constructor({ message, status, code, errors = [], raw = null }) {
    super(message);

    this.name = "ApiError";
    this.status = status;       // HTTP status code (401, 404, 500...)
    this.code = code;           // Backend custom error code ("VALIDATION_ERROR", "NOT_FOUND")
    this.errors = errors;       // Validation xatoliklari massivi
    this.raw = raw;             // Original error (debugging uchun)
    this.timestamp = new Date().toISOString();

    // HTTP kodlarini map qilish (Mantiqiy yordamchilar)
    this.isNotFound = status === 404;
    this.isUnauth = status === 401;
    this.isForbidden = status === 403;
    this.isValidation = status === 400 || status === 422;
    this.isServer = status >= 500;
    this.isNetworkError = code === "NETWORK_ERROR";
  }

  /**
   * Axios error dan ApiError yaratish
   */
  static fromAxios(error) {
    // Server javobi bor
    if (error.response) {
      const { data, status } = error.response;

      return new ApiError({
        message: data?.message || data?.error || `Server xatosi (${status})`,
        status,
        code: data?.code || `HTTP_${status}`,
        errors: data?.errors || [],
        raw: error,
      });
    }

    // Request yuborildi, lekin javob kelmadi (timeout, network)
    if (error.request) {
      return new ApiError({
        message: "Serverga ulanib bo'lmadi. Internet aloqangizni tekshiring.",
        status: 0,
        code: "NETWORK_ERROR",
        raw: error,
      });
    }

    // So'rov yaratishda xatolik
    return new ApiError({
      message: error.message || "Noma'lum xatolik yuz berdi",
      status: -1,
      code: "CLIENT_ERROR",
      raw: error,
    });
  }

  /**
   * Validation xatoliklarini field bo'yicha olish
   * Misol: error.getFieldError("email") => "Email noto'g'ri"
   */
  getFieldError(fieldName) {
    const found = this.errors.find(
      (e) => e.field === fieldName || e.param === fieldName
    );
    return found?.message || null;
  }

  /**
   * Barcha validation xatoliklarini { field: message } formatiga o'girish
   */
  getFieldErrors() {
    return this.errors.reduce((acc, err) => {
      const key = err.field || err.param;
      if (key) acc[key] = err.message;
      return acc;
    }, {});
  }

}
