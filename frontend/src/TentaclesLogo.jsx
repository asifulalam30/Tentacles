// Tentacles logo — Concept B (monoline tentacle spiral with suckers).
// Single source of truth so the sidebar, lock screen, and dashboard all match.
import React from 'react';

export function TentaclesLogo({ size = 30, radius = 7 }) {
  return (
    <div style={{
      width: size, height: size,
      background: '#0B1220',
      border: '1px solid #243349',
      borderRadius: radius,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <svg width={size * 0.78} height={size * 0.78} viewBox="0 0 120 120" fill="none">
        <defs>
          <linearGradient id="tentacleGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0EA5E9" />
            <stop offset="1" stopColor="#0369A1" />
          </linearGradient>
        </defs>
        <path
          d="M30 30 C 70 30, 90 50, 86 80 C 83 102, 58 104, 52 86 C 47 71, 62 64, 70 74"
          stroke="url(#tentacleGrad)" strokeWidth="7" strokeLinecap="round" fill="none"
        />
        <g fill="#7DD3FC">
          <circle cx="42" cy="33" r="2.4" />
          <circle cx="56" cy="33" r="2.4" />
          <circle cx="70" cy="38" r="2.4" />
          <circle cx="80" cy="50" r="2.4" />
          <circle cx="84" cy="66" r="2.4" />
          <circle cx="80" cy="82" r="2.4" />
          <circle cx="68" cy="92" r="2.4" />
        </g>
      </svg>
    </div>
  );
}
