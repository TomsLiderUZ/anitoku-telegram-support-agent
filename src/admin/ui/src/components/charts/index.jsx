import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styles from "./index.module.scss";
import { compact } from "../../utils/format";

/**
 * Diagrammalar.
 *
 * NEGA RANGLAR CSS'DAN O'QILADI: recharts ranglarni JS qiymati
 * sifatida talab qiladi — `var(--color-chart-1)` ni tushunmaydi.
 * Agar hex to'g'ridan-to'g'ri yozilsa, mavzu almashganda diagramma
 * eski rangda qolib, butun sahifadan ajralib turardi. Shuning uchun
 * tokenlar `getComputedStyle` bilan o'qiladi va mavzu o'zgarganda
 * ("themechange" hodisasi) qaytadan olinadi.
 */
const TOKENS = [
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-grid",
  "--color-text-muted",
  "--color-bg-surface",
  "--color-border-primary",
  "--color-text-primary",
];

const readTokens = () => {
  const cs = getComputedStyle(document.documentElement);
  return TOKENS.reduce((acc, name) => {
    acc[name] = cs.getPropertyValue(name).trim();
    return acc;
  }, {});
};

function usePalette() {
  const [tokens, setTokens] = useState(readTokens);

  useEffect(() => {
    const update = () => setTokens(readTokens());
    window.addEventListener("themechange", update);
    return () => window.removeEventListener("themechange", update);
  }, []);

  return {
    series: [
      tokens["--color-chart-1"],
      tokens["--color-chart-2"],
      tokens["--color-chart-3"],
      tokens["--color-chart-4"],
      tokens["--color-chart-5"],
      tokens["--color-chart-6"],
    ],
    grid: tokens["--color-chart-grid"],
    muted: tokens["--color-text-muted"],
    surface: tokens["--color-bg-surface"],
    border: tokens["--color-border-primary"],
    text: tokens["--color-text-primary"],
  };
}

/** Umumiy tooltip — uchala diagramma uchun bir xil ko'rinish. */
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  return (
    <div className={styles.tooltip}>
      {label !== undefined && <p className={styles.tooltipLabel}>{label}</p>}
      {payload.map((entry) => (
        <p key={entry.dataKey || entry.name} className={styles.tooltipRow}>
          <span className={styles.tooltipDot} style={{ background: entry.color }} />
          {entry.name}
          <strong>{compact(entry.value)}</strong>
        </p>
      ))}
    </div>
  );
}

const AXIS = { fontSize: 11, tickLine: false, axisLine: false };

/**
 * TrendChart — vaqt bo'yicha o'zgarish.
 *
 * `series`: [{ key, name }] — bir nechta chiziq bo'lishi mumkin.
 * Chiziq ostidagi to'ldirish gradient bilan so'nadi: hajm hissi
 * beradi, lekin ostidagi to'rni bosmaydi.
 */
export function TrendChart({ data = [], series = [], xKey = "label", height = 260 }) {
  const palette = usePalette();
  const gradientId = `grad-${series.map((s) => s.key).join("-")}`;

  return (
    <div className={styles.chart} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={palette.series[i % 6]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={palette.series[i % 6]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis dataKey={xKey} stroke={palette.muted} {...AXIS} />
          <YAxis stroke={palette.muted} tickFormatter={compact} width={52} {...AXIS} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: palette.border }} />

          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={palette.series[i % 6]}
              strokeWidth={2}
              fill={`url(#${gradientId}-${i})`}
              // Nuqta faqat sichqoncha ustiga kelganda — 96 ta nuqta
              // doim ko'rinib tursa chiziqning shakli yo'qoladi
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              animationDuration={600}
            />
          ))}

          {series.length > 1 && (
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 12, color: palette.muted, paddingTop: 8 }}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * RankChart — reyting (eng ko'p yozgan chatlar, provayderlar…).
 *
 * Gorizontal, chunki nomlar uzun bo'ladi: vertikal ustunda ular
 * qiyshaytirib yoziladi va o'qib bo'lmaydi.
 */
export function RankChart({ data = [], nameKey = "name", valueKey = "value", height = 260 }) {
  const palette = usePalette();

  return (
    <div className={styles.chart} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
          <CartesianGrid stroke={palette.grid} horizontal={false} />
          <XAxis type="number" stroke={palette.muted} tickFormatter={compact} {...AXIS} />
          <YAxis
            type="category"
            dataKey={nameKey}
            stroke={palette.muted}
            width={132}
            {...AXIS}
            // Uzun nomni kesamiz: to'liq nomi tooltipda ko'rinadi
            tickFormatter={(v) => (String(v).length > 18 ? `${String(v).slice(0, 17)}…` : v)}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: palette.grid, fillOpacity: 0.4 }} />
          <Bar dataKey={valueKey} radius={[0, 6, 6, 0]} animationDuration={600}>
            {data.map((_, i) => (
              <Cell key={i} fill={palette.series[i % 6]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * DonutChart — butunning tarkibi.
 *
 * O'rtasidagi bo'shliqqa umumiy son yoziladi (`center`): aks holda
 * foydalanuvchi bo'laklarni ko'zi bilan qo'shishga urinadi.
 */
export function DonutChart({ data = [], height = 240, center }) {
  const palette = usePalette();

  return (
    <div className={styles.donut} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="86%"
            paddingAngle={2}
            stroke="none"
            animationDuration={600}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={palette.series[i % 6]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, color: palette.muted }}
          />
        </PieChart>
      </ResponsiveContainer>

      {center && <div className={styles.donutCenter}>{center}</div>}
    </div>
  );
}
