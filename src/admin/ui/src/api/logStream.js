/**
 * Jonli jurnal oqimi (Server-Sent Events).
 *
 * NEGA SSE, POLLING EMAS: jurnal — bir tomonlama oqim, server yozadi,
 * panel oʻqiydi. SSE aynan shuning uchun yaratilgan: bitta ochiq
 * ulanish, aloqa uzilsa brauzer OʻZI qayta ulanadi. Har soniyada
 * soʻrov yuborish esa server va tarmoqni bekorga band qilardi va
 * baribir kechikish bilan kelardi.
 *
 * Sessiya cookie'si avtomatik yuboriladi (bir xil origin), shuning
 * uchun qoʻshimcha autentifikatsiya kerak emas.
 */

const BASE = process.env.REACT_APP_API_BASE_URL || "/api";

export function streamLogs(onEntry) {
  let source;

  try {
    source = new EventSource(`${BASE}/logs/stream`);
  } catch {
    // EventSource yoʻq yoki bloklangan — jurnal jonli boʻlmaydi,
    // lekin sahifa ishlashda davom etadi.
    return () => {};
  }

  source.onmessage = (event) => {
    try {
      onEntry(JSON.parse(event.data));
    } catch {
      // Buzilgan qator — tashlab yuboramiz, oqim davom etadi
    }
  };

  // Xatoni ushlab qolmaymiz: brauzer oʻzi qayta ulanadi va bu
  // odatiy hol (masalan server qayta ishga tushganda).
  source.onerror = () => {};

  return () => source.close();
}
