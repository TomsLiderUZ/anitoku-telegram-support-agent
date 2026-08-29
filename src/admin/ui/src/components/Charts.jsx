/**
 * Chart wrappers.
 *
 * Recharts is configured once here so every chart in the panel shares the same
 * grid weight, tooltip, spacing and palette — a dashboard where each chart
 * styles itself reads as several dashboards stitched together.
 *
 * Colours come from the CSS tokens, read at render time, so switching theme
 * repaints the charts too.
 */
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
} from 'recharts';
import styles from './Charts.module.css';

const token = (name, fallback) => {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

export const palette = () => [
  token('--chart-1', '#7c6cff'),
  token('--chart-2', '#3ddc97'),
  token('--chart-3', '#4cc2ff'),
  token('--chart-4', '#ffb340'),
  token('--chart-5', '#ff6b9d'),
  token('--chart-6', '#a78bfa'),
];

const axisProps = {
  stroke: 'transparent',
  tick: { fill: token('--text-muted', '#6b7488'), fontSize: 11 },
  tickLine: false,
  axisLine: false,
};

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className={styles.tooltip}>
      <div className={styles.tipLabel}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className={styles.tipRow}>
          <span className={styles.tipDot} style={{ background: p.color }} />
          <span className={styles.tipName}>{p.name}</span>
          <span className={styles.tipValue}>
            {Number(p.value).toLocaleString('uz-UZ')}
            {unit || ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Time series. Area rather than line: the fill makes a quiet period obvious. */
export function TrendChart({ data, series, height = 220, unit }) {
  const colors = palette();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors[i % colors.length]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={colors[i % colors.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={token('--chart-grid', '#232a36')} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...axisProps} minTickGap={28} />
        <YAxis {...axisProps} width={44} allowDecimals={false} />
        <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: token('--border', '#232a36') }} />
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={colors[i % colors.length]}
            strokeWidth={2}
            fill={`url(#g-${s.key})`}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars — for comparing named things (providers, purposes). */
export function RankChart({ data, dataKey, nameKey = 'name', height = 220, unit }) {
  const colors = palette();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
        <CartesianGrid stroke={token('--chart-grid', '#232a36')} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" {...axisProps} />
        <YAxis type="category" dataKey={nameKey} {...axisProps} width={112} />
        <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ fill: token('--bg-hover', '#ffffff0a') }} />
        <Bar dataKey={dataKey} radius={[0, 6, 6, 0]} barSize={16}>
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Composition. A donut, not a pie: the hole carries the total. */
export function DonutChart({ data, dataKey = 'value', nameKey = 'name', height = 220, center }) {
  const colors = palette();
  return (
    <div className={styles.donutWrap} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey={dataKey}
            nameKey={nameKey}
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={2}
            stroke="none"
          >
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
          <Legend
            verticalAlign="bottom"
            height={28}
            iconType="circle"
            iconSize={8}
            formatter={(v) => <span className={styles.legend}>{v}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
      {center && <div className={styles.donutCenter}>{center}</div>}
    </div>
  );
}
