/** Nova, the Deepfield mascot. A living plasma core: the emotion lives in the
 *  filaments and the eyes. Same drawing grammar as the Galaxy3D plasma globe
 *  (white core stroke + cyan sheath per bolt) and same paths as public/nova.svg.
 *  Pure SVG + CSS, no runtime deps. */
import { useId } from 'react';
import './mascot.css';

const MOODS = ['idle', 'thinking', 'spark', 'oops'] as const;
export type MascotMood = (typeof MOODS)[number];

/** One filament, two passes: cyan sheath under a white core stroke. */
function Bolt({ d, dim = false }: { d: string; dim?: boolean }) {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke="#59c2ff" strokeWidth={dim ? 2 : 2.8} opacity={dim ? 0.28 : 0.55} />
      <path d={d} stroke="#ffffff" strokeWidth={dim ? 0.8 : 1.3} opacity={dim ? 0.4 : 0.9} />
    </g>
  );
}

/** Two path variants flicker in alternation to fake bolt regeneration in CSS. */
function Filament({ a, b }: { a: string; b: string }) {
  return (
    <>
      <g className="mascot-fil-a"><Bolt d={a} /></g>
      <g className="mascot-fil-b"><Bolt d={b} /></g>
    </>
  );
}

const FIL = {
  left: {
    a: 'M322 234 L302 240 L286 234 L262 256 L252 252 L240 270',
    b: 'M322 234 L306 244 L290 238 L268 258 L256 258 L242 274',
  },
  down: {
    a: 'M332 236 L342 250 L336 262 L352 284 L348 296 L360 314',
    b: 'M332 236 L338 252 L344 264 L346 286 L354 298 L352 316',
  },
  upLeft: {
    a: 'M320 192 L310 178 L298 170 L294 154 L282 146 L268 124',
    b: 'M320 192 L314 176 L302 166 L290 156 L286 142 L270 128',
  },
  upRight: {
    a: 'M340 192 L350 178 L362 170 L366 154 L378 146 L392 124',
    b: 'M340 192 L346 176 L358 166 L370 156 L374 142 L390 128',
  },
  spark: {
    a: 'M352 220 L370 210 L374 198 L390 188 L388 176 L404 166 L408 154 L418 148',
    b: 'M352 220 L366 214 L376 202 L386 192 L392 178 L400 168 L410 156 L418 148',
  },
} as const;

export function Mascot({ mood = 'idle', size = 96 }: { mood?: string; size?: number }) {
  const m: MascotMood = (MOODS as readonly string[]).includes(mood) ? (mood as MascotMood) : 'idle';
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const coreId = `nova-core-${uid}`;
  const rimId = `nova-rim-${uid}`;
  const glowId = `nova-glow-${uid}`;

  return (
    <svg
      className={`mascot mascot--${m}`}
      width={size}
      height={size}
      viewBox="206 88 248 248"
      role="img"
      aria-label={`Nova the Deepfield mascot, ${m}`}
    >
      <defs>
        <radialGradient id={coreId} cx="50%" cy="55%" r="50%">
          <stop offset="0%" stopColor="#eaf6ff" stopOpacity="0.9" />
          <stop offset="30%" stopColor="#9fd8ff" stopOpacity="0.65" />
          <stop offset="60%" stopColor="#59c2ff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#59c2ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={rimId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#59c2ff" stopOpacity="0" />
          <stop offset="82%" stopColor="#59c2ff" stopOpacity="0" />
          <stop offset="97%" stopColor="#59c2ff" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#59c2ff" stopOpacity="0.16" />
        </radialGradient>
        <filter id={glowId} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* membrane */}
      <circle cx="330" cy="212" r="108" fill={`url(#${rimId})`} stroke="#2a3644" strokeWidth="2" />
      <circle cx="330" cy="212" r="104" fill="none" stroke="#59c2ff" strokeWidth="1" opacity="0.14" />

      {/* core glow, pulses in CSS */}
      <circle className="mascot-core" cx="330" cy="212" r="58" fill={`url(#${coreId})`} />

      {/* filaments per mood */}
      {m === 'idle' && (
        <>
          <Filament a={FIL.left.a} b={FIL.left.b} />
          <Filament a={FIL.down.a} b={FIL.down.b} />
        </>
      )}
      {m === 'thinking' && (
        <>
          <Filament a={FIL.left.a} b={FIL.left.b} />
          <Filament a={FIL.down.a} b={FIL.down.b} />
          <Filament a={FIL.upLeft.a} b={FIL.upLeft.b} />
          <Filament a={FIL.upRight.a} b={FIL.upRight.b} />
        </>
      )}
      {m === 'spark' && (
        <>
          <Filament a={FIL.left.a} b={FIL.left.b} />
          <Filament a={FIL.down.a} b={FIL.down.b} />
          <Filament a={FIL.spark.a} b={FIL.spark.b} />
          <g filter={`url(#${glowId})`}>
            <circle cx="419" cy="147" r="6" fill="#ffc678" />
            <g stroke="#ffc678" strokeWidth="2" strokeLinecap="round" opacity="0.9">
              <line x1="419" y1="133" x2="419" y2="126" />
              <line x1="419" y1="161" x2="419" y2="168" />
              <line x1="405" y1="147" x2="398" y2="147" />
              <line x1="433" y1="147" x2="440" y2="147" />
              <line x1="429" y1="137" x2="434" y2="132" />
              <line x1="409" y1="157" x2="404" y2="162" />
            </g>
          </g>
        </>
      )}
      {m === 'oops' && (
        <>
          <Bolt d="M322 236 L314 258 L318 274 L306 296" dim />
          <Bolt d="M340 236 L346 260 L342 276 L350 300" dim />
        </>
      )}

      {/* eyes per mood */}
      <g className="mascot-eyes" fill="none" stroke="#ffffff" strokeLinecap="round" filter={`url(#${glowId})`}>
        {m === 'idle' && (
          <g fill="#ffffff" stroke="none">
            <circle cx="308" cy="205" r="5" />
            <circle cx="352" cy="205" r="5" />
          </g>
        )}
        {m === 'thinking' && (
          <g strokeWidth="5">
            <path d="M298 206 Q 309 202 320 206" />
            <path d="M340 206 Q 351 202 362 206" />
          </g>
        )}
        {m === 'spark' && (
          <g strokeWidth="5.5">
            <path d="M296 212 Q 308 199 320 212" />
            <path d="M340 212 Q 352 199 364 212" />
          </g>
        )}
        {m === 'oops' && (
          <g fill="#ffffff" stroke="none" opacity="0.75">
            <circle cx="310" cy="210" r="3.5" />
            <circle cx="350" cy="210" r="3.5" />
          </g>
        )}
      </g>
    </svg>
  );
}
