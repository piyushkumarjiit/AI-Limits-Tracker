import React from 'react';
import type { ProviderType } from '../../../../src/models/types';
import { Colors, PROVIDER_NAMES } from '../../../../src/constants/theme';

/* ---------- Provider logos ---------- */

const CLAUDE_RAYS: Array<[number, number]> = [
  [-90, 10.5], [-58, 9.2], [-28, 10.8], [4, 9.6], [33, 10.6], [62, 9],
  [92, 10.8], [122, 9.4], [150, 10.4], [180, 9.4], [208, 10.8], [238, 9.2],
];
const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

const NATIVE_LOGOS = new Set(['claude', 'chatgpt', 'gemini']);

export const Logo: React.FC<{ type: ProviderType; size?: number }> = ({ type, size = 42 }) => {
  const radius = Math.round(size * 0.28);
  const inner = size - Math.round(size * 0.22) * 2;

  // Monogram for recipe-driven / custom services
  if (!NATIVE_LOGOS.has(type)) {
    const scheme = Colors[type] || Colors.custom;
    const letter = (PROVIDER_NAMES[type] || '?').replace(/^GitHub\s+/, '').charAt(0).toUpperCase();
    return (
      <div className="logo" style={{ width: size, height: size, borderRadius: radius, background: scheme.primary, color: '#fff', fontWeight: 800, fontSize: Math.round(size * 0.46) }}>
        {letter}
      </div>
    );
  }

  const bg = type === 'claude' ? '#d97757' : type === 'chatgpt' ? '#10a37f' : '#eef1fd';
  return (
    <div className="logo" style={{ width: size, height: size, borderRadius: radius, background: bg }}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" aria-hidden>
        {type === 'claude' &&
          CLAUDE_RAYS.map(([a, len], i) => {
            const r = (a * Math.PI) / 180;
            return (
              <line key={i} x1={12 + Math.cos(r) * 1.2} y1={12 + Math.sin(r) * 1.2} x2={12 + Math.cos(r) * len} y2={12 + Math.sin(r) * len} stroke="#fff" strokeWidth={2.1} strokeLinecap="round" />
            );
          })}
        {type === 'chatgpt' && <path d={OPENAI_PATH} fill="#fff" />}
        {type === 'gemini' && (
          <>
            <defs>
              <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4f46e5" />
                <stop offset="55%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#06b6d4" />
              </linearGradient>
            </defs>
            <path d="M12 0C12 6.627 6.627 12 0 12C6.627 12 12 17.373 12 24C12 17.373 17.373 12 24 12C17.373 12 12 6.627 12 0Z" fill="url(#gem)" />
          </>
        )}
      </svg>
    </div>
  );
};
