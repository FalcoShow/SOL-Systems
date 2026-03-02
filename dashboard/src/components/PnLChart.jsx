// ============================================================
//  SOL SYSTEMS — PnLChart Component
//  File: dashboard/src/components/PnLChart.jsx
//
//  Recharts-based line chart for cumulative PnL over time.
//  Used on the Analytics page and the main dashboard.
//
//  Props:
//    data        — array of { timestamp, cumulative, tradePnl, isWin }
//    currency    — 'SOL' | 'USD' (default 'SOL')
//    height      — chart height in px (default 300)
//    showTooltip — boolean (default true)
//    isLoading   — boolean, shows skeleton when true
// ============================================================

import React, { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

// ── Helpers ──────────────────────────────────────────────────

function formatLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatValue(val, currency) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return currency === 'USD'
    ? `${sign}$${Math.abs(n).toFixed(2)}`
    : `${sign}${n.toFixed(4)} SOL`;
}

// ── Custom tooltip shown on hover ────────────────────────────

function CustomTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null;

  const point    = payload[0]?.payload;
  const cumValue = payload[0]?.value;
  const isPositive = (cumValue ?? 0) >= 0;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs shadow-xl">
      <div className="text-gray-400 mb-1">
        {point?.timestamp ? new Date(point.timestamp).toLocaleString() : label}
      </div>
      <div className={`font-semibold text-sm ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
        {formatValue(cumValue, currency)}
      </div>
      {point?.tradePnl != null && (
        <div className={`mt-1 ${(point.tradePnl ?? 0) >= 0 ? 'text-green-300' : 'text-red-300'}`}>
          Trade: {formatValue(point.tradePnl, currency)}
        </div>
      )}
      {point?.tokenSymbol && (
        <div className="text-gray-500 mt-0.5">{point.tokenSymbol}</div>
      )}
    </div>
  );
}

// ── Skeleton loader ──────────────────────────────────────────

function ChartSkeleton({ height }) {
  return (
    <div
      className="animate-pulse bg-gray-800/50 rounded-lg flex items-center justify-center"
      style={{ height }}
    >
      <span className="text-gray-600 text-sm">Loading chart…</span>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────

function EmptyChart({ height }) {
  return (
    <div
      className="bg-gray-800/30 rounded-lg border border-gray-700/50 flex items-center justify-center"
      style={{ height }}
    >
      <div className="text-center">
        <div className="text-gray-500 text-sm">No trade data yet</div>
        <div className="text-gray-600 text-xs mt-1">
          PnL curve will appear after your first closed trade
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  MAIN COMPONENT
// ────────────────────────────────────────────────────────────

export function PnLChart({
  data        = [],
  currency    = 'SOL',
  height      = 300,
  showTooltip = true,
  isLoading   = false,
}) {
  const [activeDot, setActiveDot] = useState(null);

  if (isLoading) return <ChartSkeleton height={height} />;
  if (!data || data.length === 0) return <EmptyChart height={height} />;

  // Determine line color based on final PnL
  const finalValue = data[data.length - 1]?.cumulative ?? 0;
  const lineColor  = finalValue >= 0 ? '#22c55e' : '#ef4444';  // green-500 or red-500

  // Tick formatter for Y axis
  const yTickFormatter = (val) => {
    if (currency === 'USD') return `$${val.toFixed(0)}`;
    return `${val.toFixed(2)}`;
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart
        data={data}
        margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
        onMouseLeave={() => setActiveDot(null)}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="#374151"  // gray-700
          vertical={false}
        />

        <XAxis
          dataKey="timestamp"
          tickFormatter={formatLabel}
          tick={{ fill: '#6b7280', fontSize: 11 }}  // gray-500
          tickLine={false}
          axisLine={{ stroke: '#374151' }}
          minTickGap={60}
        />

        <YAxis
          tickFormatter={yTickFormatter}
          tick={{ fill: '#6b7280', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={60}
        />

        {/* Zero line — helps visualise profit vs loss instantly */}
        <ReferenceLine
          y={0}
          stroke="#4b5563"  // gray-600
          strokeDasharray="4 4"
        />

        {showTooltip && (
          <Tooltip
            content={<CustomTooltip currency={currency} />}
            cursor={{ stroke: '#4b5563', strokeWidth: 1 }}
          />
        )}

        <Line
          type="monotone"
          dataKey="cumulative"
          stroke={lineColor}
          strokeWidth={2}
          dot={false}
          activeDot={{
            r:           5,
            fill:        lineColor,
            stroke:      '#111827',
            strokeWidth: 2,
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ────────────────────────────────────────────────────────────
//  CURRENCY TOGGLE — pairs with PnLChart
// ────────────────────────────────────────────────────────────

export function CurrencyToggle({ value, onChange }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
      {['SOL', 'USD'].map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`px-3 py-1 transition-colors ${
            value === c
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:text-white'
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

export default PnLChart;