import { useEffect, useState } from "react";

/**
 * Media query'ni JS dan kuzatish.
 *
 * CSS bilan hal qilib bo'ladigan narsani CSS da qilish kerak. Bu hook
 * faqat TARTIB o'zgarganda — ya'ni ekranda qaysi elementlar UMUMAN
 * bo'lishi kerakligi o'zgarganda ishlatiladi.
 *
 * Chatlarda aynan shunday: telefonda ro'yxat va yozishma bir vaqtda
 * turmaydi, biri ikkinchisining o'rnini oladi. Ularni CSS bilan
 * yashirish yetarli emas edi — ko'rinmas panel ham DOM da qolib,
 * ostidagi elementni to'sib turardi va ikkalasi bir-birining ustida
 * chizilib ketardi.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    // Hook o'rnatilgunicha o'lcham o'zgargan bo'lishi mumkin
    setMatches(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Chatlar ikki panelni birga ko'rsata oladigan eng kichik kenglik. */
export const useIsNarrowLayout = () => useMediaQuery("(max-width: 900px)");
