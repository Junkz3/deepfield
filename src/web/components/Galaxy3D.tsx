// THE PLANET OF FILES — permanent stage of the app.
// One holographic body of document-cards around the agent core. The scene is
// still by design; the USER navigates, and the AGENT animates it: retrieval
// flies the camera to the touched file, real manual pages fan out in space,
// beams link the evidence back to the core.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, Line, OrbitControls, Text } from '@react-three/drei';
import { XR, createXRStore, IfInSessionMode, XROrigin, useXR, useXRInputSourceState } from '@react-three/xr';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import type { Document } from '../../agent/types';
import { pageTitle } from '../../agent/taxonomy';
import { useApp } from '../store';
import { catColor } from '../cat-colors';
import displayFont from '@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff?url';

const R = 2.75; // shell radius of the file planet

// Ambient idle orbit: rotate the camera around the agent. Time-based AND
// low-pass smoothed, because the galaxy scene dips below 60fps: a target angle
// advances with real elapsed time, the applied angle eases toward it, so a
// dropped frame's catch-up is spread over several frames instead of landing as
// one visible jump (which is what read as stutter).
// A tilted axis (not straight up) so the sphere sweeps on a diagonal around the
// agent instead of flat left-to-right. Kept modest so the camera's elevation
// stays inside the OrbitControls polar limits over a full turn (no clamp jump).
const IDLE_AXIS = new THREE.Vector3(0.32, 1, 0.2).normalize();
const IDLE_SPIN_RATE = 0.05; // rad/s, gentle target speed (~2min per turn)
const IDLE_SPIN_SMOOTH = 4.5; // low-pass rate; smaller = smoother but laggier

// Reused per-frame scratch vectors: a `new THREE.Vector3()` inside a useFrame
// runs 60x/s (and 30x that across the file cards), and the churn triggers GC
// pauses that read as stutter. Allocate once, reuse.
const _cardScale = new THREE.Vector3();
const _camOff = new THREE.Vector3();

// WebXR entry point. The built-in emulator lets the VR path be exercised (and
// filmed) without a headset. But @pmndrs/xr defaults `emulate` to 'metaQuest3'
// when omitted (loads a ~112kB chunk, and on localhost injects an "Enter XR"
// overlay over every header, including our demo-capture target `vite preview`).
// So we must pass `emulate: false` to opt OUT: emulator on in dev, opt-in on a
// built preview via ?xr (to film VR), off otherwise.
// No synthetic room: our own deep space IS the environment.
const xrEmulatorEnabled =
  import.meta.env.DEV ||
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('xr'));
const xrStore = createXRStore(
  xrEmulatorEnabled ? { emulate: { syntheticEnvironment: false } } : { emulate: false },
);

const rnd = (seed: number) => Math.sin(seed * 127.1 + 311.7) * 0.5 + Math.sin(seed * 74.7) * 0.5;

/* ---------- textures ---------- */

const cardTextureCache = new Map<string, THREE.CanvasTexture>();
function fileCardTexture(color: string): THREE.CanvasTexture {
  const hit = cardTextureCache.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 160;
  const g = c.getContext('2d')!;
  const fold = 30;
  g.beginPath();
  g.moveTo(10, 6); g.lineTo(128 - fold - 10, 6); g.lineTo(118, fold + 6);
  g.lineTo(118, 154); g.lineTo(10, 154); g.closePath();
  g.fillStyle = 'rgba(10, 16, 24, 0.6)';
  g.fill();
  g.strokeStyle = color; g.lineWidth = 3; g.stroke();
  g.beginPath();
  g.moveTo(128 - fold - 10, 6); g.lineTo(128 - fold - 10, fold + 6); g.lineTo(118, fold + 6); g.closePath();
  g.fillStyle = color; g.globalAlpha = 0.5; g.fill(); g.globalAlpha = 1;
  g.strokeStyle = color; g.lineWidth = 4; g.globalAlpha = 0.5;
  for (let i = 0; i < 5; i++) {
    g.beginPath(); g.moveTo(24, 44 + i * 20); g.lineTo(24 + 70 - (i % 3) * 18, 44 + i * 20); g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  cardTextureCache.set(color, tex);
  return tex;
}

let playBadgeTex: THREE.CanvasTexture | null = null;
function playBadge(): THREE.CanvasTexture {
  if (playBadgeTex) return playBadgeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d')!;
  g.beginPath(); g.arc(48, 48, 40, 0, Math.PI * 2);
  g.fillStyle = 'rgba(8, 11, 16, 0.72)'; g.fill();
  g.lineWidth = 4; g.strokeStyle = '#ffffff'; g.stroke();
  g.beginPath(); g.moveTo(38, 30); g.lineTo(70, 48); g.lineTo(38, 66); g.closePath();
  g.fillStyle = '#ffffff'; g.fill();
  playBadgeTex = new THREE.CanvasTexture(c);
  return playBadgeTex;
}

function radialSprite(rgb: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, `rgba(${rgb},0.85)`);
  grad.addColorStop(0.35, `rgba(${rgb},0.28)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/** Rounded tempered-glass panel for VR UI: dark fill, top sheen, glowing
 *  border. Cached per size+color, like the file card textures. */
const panelTexCache = new Map<string, THREE.CanvasTexture>();
function roundedPanelTexture(w: number, h: number, r: number, stroke: string): THREE.CanvasTexture {
  const key = [w, h, r, stroke].join('|');
  const hit = panelTexCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.roundRect(3, 3, w - 6, h - 6, Math.min(r, (h - 6) / 2));
  g.fillStyle = 'rgba(11, 17, 24, 0.85)';
  g.fill();
  const sheen = g.createLinearGradient(0, 0, 0, h);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
  sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
  g.fillStyle = sheen;
  g.fill();
  g.strokeStyle = stroke;
  g.lineWidth = 3;
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  panelTexCache.set(key, tex);
  return tex;
}

const VR_LINE = 'rgba(64, 80, 98, 0.9)';
const VR_AIM = 'rgba(89, 194, 255, 0.95)';
const VR_ACCENT = 'rgba(255, 180, 84, 0.95)';

/** Word-boundary truncation with a real ellipsis: no mid-word chops. */
/** One texture per URL, kept forever (small corpus). Pages remount all the
 *  time (arc paging, focus in/out); reloading and re-decoding the image on
 *  every mount made them blink like a reload. */
const texCache = new Map<string, THREE.Texture>();
function useCachedTexture(url?: string): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(url ? texCache.get(url) ?? null : null);
  useEffect(() => {
    if (!url) { setTex(null); return; }
    const hit = texCache.get(url);
    if (hit) { setTex(hit); return; }
    let alive = true;
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      texCache.set(url, t);
      if (alive) setTex(t);
    }, undefined, () => { if (alive) setTex(null); });
    return () => { alive = false; };
  }, [url]);
  return tex;
}

/** Warm the cache ahead of a page flip: the neighbor pages of a focused page
 *  are unmounted, so without this the next page starts as a blank. */
const texPending = new Set<string>();
function prefetchTexture(url?: string) {
  if (!url || texCache.has(url) || texPending.has(url)) return;
  texPending.add(url);
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(url, t);
    texPending.delete(url);
  }, undefined, () => texPending.delete(url));
}

function ell(s: string, n: number): string {
  if (s.length <= n) return s;
  const sp = s.lastIndexOf(' ', n);
  return s.slice(0, sp > n - 14 ? sp : n).trimEnd() + '…';
}

/* ---------- environment: refined deep space, no screensaver stars ---------- */

function DeepSpace() {
  const { fine, bright } = useMemo(() => {
    const fineArr: number[] = [];
    const brightArr: number[] = [];
    for (let i = 0; i < 850; i++) {
      const r = 16 + Math.abs(rnd(i * 3.7)) * 26;
      const th = rnd(i * 1.3) * Math.PI * 2;
      const ph = Math.acos(Math.max(-1, Math.min(1, rnd(i * 2.9))));
      const x = r * Math.sin(ph) * Math.cos(th);
      const y = r * Math.cos(ph) * 0.7;
      const z = r * Math.sin(ph) * Math.sin(th);
      (i % 9 === 0 ? brightArr : fineArr).push(x, y, z);
    }
    return { fine: new Float32Array(fineArr), bright: new Float32Array(brightArr) };
  }, []);

  const nebulaBlue = useMemo(() => radialSprite('42, 68, 104'), []);
  const nebulaViolet = useMemo(() => radialSprite('58, 44, 92'), []);

  return (
    <group>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[fine, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#5f7286" size={0.035} sizeAttenuation transparent opacity={0.5} depthWrite={false} />
      </points>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[bright, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#b9cadb" size={0.07} sizeAttenuation transparent opacity={0.8} depthWrite={false} />
      </points>
      <sprite position={[-14, 4, -26]} scale={[30, 30, 1]}>
        <spriteMaterial map={nebulaBlue} transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <sprite position={[16, -6, -30]} scale={[36, 36, 1]}>
        <spriteMaterial map={nebulaViolet} transparent opacity={0.38} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}

/** Fine instrument-like orbit rings around the planet. */
function OrbitRings() {
  const mk = (radius: number, segments = 128) => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push([Math.cos(a) * radius, 0, Math.sin(a) * radius]);
    }
    return pts;
  };
  return (
    <group>
      <group rotation={[0.18, 0, 0.06]}>
        <Line points={mk(R * 1.28)} color="#2a3644" lineWidth={1} transparent opacity={0.35} />
      </group>
      <group rotation={[-0.12, 0.5, -0.08]}>
        <Line points={mk(R * 1.52)} color="#232c37" lineWidth={1} transparent opacity={0.25} dashed dashScale={14} />
      </group>
    </group>
  );
}

/* ---------- lightning: neon energy links, plasma-globe style ---------- */

const BOLT_PTS = 22;

function makeBoltLine(color: string, opacity: number, pts = BOLT_PTS): THREE.Line {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((pts + 1) * 3), 3));
  const mat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  return line;
}

/** One crackling bolt from the core to a target. A single jittered master
 *  path regenerates ~14x/s; the three passes (white core, colored sheath,
 *  wide halo) all hug it so they read as ONE bolt with a glow. */
function LightningBolt({ to, color, interval = 0.07 }: { to: THREE.Vector3; color: string; interval?: number }) {
  const lines = useMemo(
    () => [makeBoltLine('#ffffff', 0.95), makeBoltLine(color, 0.55), makeBoltLine(color, 0.22)],
    [color],
  );
  useEffect(() => () => lines.forEach((l) => { l.geometry.dispose(); (l.material as THREE.Material).dispose(); }), [lines]);
  const acc = useRef(1); // draw immediately on mount

  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < interval) return;
    acc.current = 0;
    const len = to.length();
    const dir = to.clone().normalize();
    const p1 = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (p1.lengthSq() < 1e-4) p1.set(1, 0, 0);
    p1.normalize();
    const p2 = new THREE.Vector3().crossVectors(dir, p1);
    const mA = new Float32Array(BOLT_PTS + 1);
    const mB = new Float32Array(BOLT_PTS + 1);
    for (let i = 0; i <= BOLT_PTS; i++) {
      const env = Math.sin((i / BOLT_PTS) * Math.PI) * len * 0.05;
      mA[i] = (Math.random() - 0.5) * 2 * env;
      mB[i] = (Math.random() - 0.5) * 2 * env;
    }
    const fuzz = [0, 0.012, 0.03];
    lines.forEach((line, li) => {
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= BOLT_PTS; i++) {
        const t = i / BOLT_PTS;
        const f = Math.sin(t * Math.PI) * len * fuzz[li];
        const a = mA[i] + (Math.random() - 0.5) * 2 * f;
        const b = mB[i] + (Math.random() - 0.5) * 2 * f;
        pos.setXYZ(i,
          to.x * t + p1.x * a + p2.x * b,
          to.y * t + p1.y * a + p2.y * b,
          to.z * t + p1.z * a + p2.z * b);
      }
      pos.needsUpdate = true;
    });
  });

  return <group>{lines.map((l, i) => <primitive key={i} object={l} />)}</group>;
}

/* ---------- plasma globe internals: glass shell + contained filaments ---------- */

const FIL_PTS = 12;

/** One short filament inside the glass shell: same master-path + fuzz
 *  technique as LightningBolt, but the tip wanders on the inner wall. */
function PlasmaFilament({ radius, seed, active }: { radius: number; seed: number; active: boolean }) {
  const lines = useMemo(
    () => [makeBoltLine('#fff3df', 0.5, FIL_PTS), makeBoltLine('#ffb454', 0.28, FIL_PTS), makeBoltLine('#ff8f3d', 0.12, FIL_PTS)],
    [],
  );
  useEffect(() => () => lines.forEach((l) => { l.geometry.dispose(); (l.material as THREE.Material).dispose(); }), [lines]);
  const target = useRef(new THREE.Vector3(Math.cos(seed), 0.4 * Math.sin(seed * 2.3), Math.sin(seed)).normalize());
  const retargetAt = useRef(0);
  const acc = useRef(1);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (t >= retargetAt.current) {
      target.current.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      retargetAt.current = t + (active ? 0.15 + Math.random() * 0.15 : 0.4 + Math.random() * 0.5);
    }
    acc.current += dt;
    if (acc.current < 0.085) return;
    acc.current = 0;
    const dir = target.current;
    const to = dir.clone().multiplyScalar(radius);
    const p1 = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (p1.lengthSq() < 1e-4) p1.set(1, 0, 0);
    p1.normalize();
    const p2 = new THREE.Vector3().crossVectors(dir, p1);
    const mA = new Float32Array(FIL_PTS + 1);
    const mB = new Float32Array(FIL_PTS + 1);
    for (let i = 0; i <= FIL_PTS; i++) {
      const env = Math.sin((i / FIL_PTS) * Math.PI) * radius * 0.16;
      mA[i] = (Math.random() - 0.5) * 2 * env;
      mB[i] = (Math.random() - 0.5) * 2 * env;
    }
    const fuzz = [0, 0.03, 0.07];
    const baseOp = active ? [0.9, 0.5, 0.25] : [0.5, 0.28, 0.12];
    lines.forEach((line, li) => {
      (line.material as THREE.LineBasicMaterial).opacity = baseOp[li];
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= FIL_PTS; i++) {
        const tt = i / FIL_PTS;
        const f = Math.sin(tt * Math.PI) * radius * fuzz[li];
        const a = mA[i] + (Math.random() - 0.5) * 2 * f;
        const b = mB[i] + (Math.random() - 0.5) * 2 * f;
        pos.setXYZ(i,
          to.x * tt + p1.x * a + p2.x * b,
          to.y * tt + p1.y * a + p2.y * b,
          to.z * tt + p1.z * a + p2.z * b);
      }
      pos.needsUpdate = true;
    });
  });

  return <group>{lines.map((l, i) => <primitive key={i} object={l} />)}</group>;
}

/** Fresnel rim: invisible face-on, warm glowing edge that draws the globe. */
function makeGlassShellMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color('#ffb454') },
      uIntensity: { value: 0.45 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 3.0);
        gl_FragColor = vec4(uColor, fres * uIntensity);
      }
    `,
  });
}

/** While the agent scans, a few bolts probe in-scope files, retargeting
 *  fast — the plasma globe reaching for fingers. Each bolt strikes a
 *  distinct file: never two bolts on the same target. */
function ScanStorm({ targets }: { targets: { pos: THREE.Vector3; color: string }[] }) {
  const SLOTS = Math.min(5, targets.length);
  const [picks, setPicks] = useState<number[]>([]);
  const swapAt = useRef<number[]>([]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    let changed = false;
    const next = [...picks];
    for (let sIdx = 0; sIdx < SLOTS; sIdx++) {
      if (swapAt.current[sIdx] === undefined || t >= swapAt.current[sIdx]) {
        const used = new Set(next.filter((_, i) => i !== sIdx));
        const free = targets.map((_, i) => i).filter((i) => !used.has(i));
        if (free.length > 0) next[sIdx] = free[Math.floor(Math.random() * free.length)];
        swapAt.current[sIdx] = t + 0.16 + Math.random() * 0.28;
        changed = true;
      }
    }
    if (changed) setPicks(next);
  });

  if (targets.length === 0) return null;
  return (
    <group>
      {picks.slice(0, SLOTS).map((pi, sIdx) => {
        const tgt = targets[pi];
        return tgt ? <LightningBolt key={sIdx} to={tgt.pos} color={tgt.color} interval={0.055} /> : null;
      })}
    </group>
  );
}

/* ---------- VR: the universe is a place you stand in ---------- */

// Spawn: an OVERLOOK outside the planet of files (shell R=2.75), so arrival
// shows the whole universe before you fly in. VR_EYE is where the eyes land
// (origin + standing eye height ~1.6); the command post (evidence arc,
// floor rings) lives there.
const VR_SPAWN = new THREE.Vector3(0, -1.3, 4.6);
const VR_EYE = new THREE.Vector3(0, 0.3, 4.6);

/** Focus mode reading slot, LOCAL to the evidence rig: dead center, just
 *  below the eye line, 1 m out. Every focused page lands HERE regardless of
 *  which arc slot it came from — flipping pages must never move the reading
 *  position. */
const VR_READ_SLOT = new THREE.Vector3(0, 0.02, 1.02);

/** Arc slot LOCAL to the evidence rig (origin = the user's head): 2 rows x 3
 *  columns at ~1.35 m, one row above the eye line, one below. */
function vrArcLocal(i: number): THREE.Vector3 {
  const row = Math.floor(i / 3);
  const col = (i % 3) - 1;
  const ang = col * 0.55;
  const rad = 1.35;
  return new THREE.Vector3(Math.sin(ang) * rad, row === 0 ? 0.45 : -0.38, Math.cos(ang) * rad);
}

/** Evidence rig: the arc lazy-follows the gaze exactly like the message bar
 *  (deadzone + catch-up) and freezes while any page is aimed, so evidence is
 *  always delivered IN FRONT of the user, wherever they fly. Local +Z points
 *  away from the gaze so children sit at vrArcLocal slots. */
function VRArc({ frozen, children }: { frozen: boolean; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const yaw = useRef<number | null>(null);
  const chasing = useRef(false);
  const headPos = useMemo(() => new THREE.Vector3(), []);
  const headDir = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }, dt) => {
    const grp = g.current;
    if (!grp) return;
    camera.getWorldPosition(headPos);
    camera.getWorldDirection(headDir);
    const t = Math.atan2(headDir.x, headDir.z);
    if (yaw.current === null) {
      yaw.current = t;
      grp.position.copy(headPos);
      grp.rotation.y = t;
      return;
    }
    if (frozen) return;
    let d = t - yaw.current;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.75) chasing.current = true;
    if (chasing.current) {
      yaw.current += d * Math.min(dt * 3.5, 1);
      if (Math.abs(d) < 0.06) chasing.current = false;
    }
    grp.position.lerp(headPos, Math.min(dt * 5, 1));
    let rd = (yaw.current as number) - grp.rotation.y;
    rd = Math.atan2(Math.sin(rd), Math.cos(rd));
    grp.rotation.y += rd * Math.min(dt * 5, 1);
  });
  return <group ref={g}>{children}</group>;
}

/** Round laser-pressable nav pill (fan paging arrows). */
function VRNavPill({ position, label, onGo, r = 0.13 }: { position: [number, number, number]; label: string; onGo: () => void; r?: number }) {
  const [aimP, setAimP] = useState(false);
  return (
    <group position={position}>
      <Billboard>
        <mesh
          onPointerOver={(e) => { e.stopPropagation(); setAimP(true); }}
          onPointerOut={() => setAimP(false)}
          onClick={(e) => { e.stopPropagation(); onGo(); }}
        >
          <circleGeometry args={[r, 32]} />
          <meshBasicMaterial color={aimP ? '#59c2ff' : '#141d28'} transparent opacity={0.92} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0, -0.002]}>
          <ringGeometry args={[r, r + 0.012, 32]} />
          <meshBasicMaterial color={aimP ? '#59c2ff' : '#2a3644'} transparent opacity={0.9} depthWrite={false} />
        </mesh>
        <Text font={displayFont} position={[0, 0, 0.004]} fontSize={r * 0.85} color={aimP ? '#0b1118' : '#c7d3de'} anchorX="center" anchorY="middle">
          {label}
        </Text>
      </Billboard>
    </group>
  );
}

/** Pulsing halo under the document the turntable is presenting: closes the
 *  loop between "the world turns" and "THIS document". */
function FocusRing({ pos, color }: { pos: THREE.Vector3; color: string }) {
  const m = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!m.current) return;
    const t = clock.elapsedTime;
    m.current.scale.setScalar(1 + Math.sin(t * 3.2) * 0.08);
    (m.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 3.2) * 0.25;
  });
  return (
    <group position={pos.toArray()}>
      <Billboard>
        <mesh ref={m}>
          <ringGeometry args={[0.42, 0.445, 48]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </Billboard>
    </group>
  );
}

/** Dashed filament from the evidence arc down to the document the pages came
 *  from: spatial breadcrumb (the world never rotates; the light points home).
 *  Rendered INSIDE the arc rig, so the world end is re-projected every frame. */
function DocTether({ target, color }: { target: THREE.Vector3; color: string }) {
  // drei's Line ref is a three-stdlib Line2; only setPositions is needed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const l = ref.current;
    if (!l || !l.parent) return;
    tmp.copy(target);
    l.parent.worldToLocal(tmp);
    l.geometry.setPositions([0, -0.62, 1.05, tmp.x, tmp.y, tmp.z]);
    l.computeLineDistances();
  });
  return (
    <Line
      ref={ref}
      points={[[0, -0.62, 1.05], [0, -0.62, 1.05]]}
      color={color}
      lineWidth={1.4}
      transparent
      opacity={0.38}
      dashed
      dashSize={0.09}
      gapSize={0.06}
    />
  );
}

/** Free flight through the universe. Right stick: glide where you look.
 *  Left stick X: smooth turn. Left stick Y: fly up/down.
 *  The console and evidence arc stay at the spawn point: your command post. */
function VRLocomotion({ onFirstMove }: { onFirstMove?: () => void }) {
  const origin = useRef<THREE.Group>(null);
  const right = useXRInputSourceState('controller', 'right');
  const left = useXRInputSourceState('controller', 'left');
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const side = useMemo(() => new THREE.Vector3(), []);
  const UP = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const moved = useRef(false);

  useFrame(({ camera }, dt) => {
    const g = origin.current;
    if (!g) return;
    const rs = right?.gamepad?.['xr-standard-thumbstick'];
    const lsProbe = left?.gamepad?.['xr-standard-thumbstick'];
    if (!moved.current && (Math.abs(rs?.xAxis ?? 0) > 0.3 || Math.abs(rs?.yAxis ?? 0) > 0.3 || Math.abs(lsProbe?.xAxis ?? 0) > 0.3 || Math.abs(lsProbe?.yAxis ?? 0) > 0.3)) {
      moved.current = true;
      onFirstMove?.();
    }
    if (rs) {
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() > 1e-4) {
        fwd.normalize();
        side.crossVectors(fwd, UP);
        const speed = 2.2 * dt;
        g.position.addScaledVector(fwd, -(rs.yAxis ?? 0) * speed);
        g.position.addScaledVector(side, (rs.xAxis ?? 0) * speed);
      }
    }
    const ls = left?.gamepad?.['xr-standard-thumbstick'];
    if (ls) {
      g.position.y += -(ls.yAxis ?? 0) * 1.8 * dt;
      const x = ls.xAxis ?? 0;
      if (Math.abs(x) > 0.15) g.rotation.y -= x * 1.6 * dt;
    }
  });

  return <XROrigin ref={origin} position={VR_SPAWN.toArray()} />;
}

/** Message bar in lazy-follow: it lives in the world but glides to stay low
 *  in front of wherever the user looks — flight, stick turns and physical
 *  head turns included. MENU opens the start panel (home, preset diagnosis,
 *  recent conversations: opening one recomposes the universe). Click the
 *  field: focuses the hidden DOM input (Quest pops its system keyboard; on
 *  desktop the physical keyboard types into it). Voice will plug in later. */
function VRMessageBar({ draft, onKeyboard, onSend }: { draft: string; onKeyboard: () => void; onSend: () => void }) {
  const { state, dispatch } = useApp();
  const [aim, setAim] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const shown = draft.length > 42 ? '…' + draft.slice(-42) : draft;
  const group = useRef<THREE.Group>(null);
  const panel = useRef<THREE.Group>(null);
  const menuRef = useRef<THREE.Group>(null);
  const yaw = useRef<number | null>(null);
  const chasing = useRef(false);
  const headPos = useMemo(() => new THREE.Vector3(), []);
  const headDir = useMemo(() => new THREE.Vector3(), []);
  const slot = useMemo(() => new THREE.Vector3(), []);
  const panelSlot = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera }, dt) => {
    const g = group.current;
    if (!g) return;
    camera.getWorldPosition(headPos);
    camera.getWorldDirection(headDir);
    const targetYaw = Math.atan2(headDir.x, headDir.z);
    const first = yaw.current === null;
    if (first) yaw.current = targetYaw;
    // The start menu reads straight-on from wherever it opened.
    menuRef.current?.lookAt(headPos);
    // The bar must be a STABLE target: while the laser is on it (or the menu
    // is open) it freezes entirely. Otherwise a deadzone with hysteresis:
    // it only swings around once the gaze strays past ~38 degrees, catches
    // up, then holds still again. No permanent micro-chasing.
    if (!first && (aim !== null || menuOpen)) return;
    let d = targetYaw - (yaw.current as number);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.66) chasing.current = true;
    if (chasing.current) {
      yaw.current = (yaw.current as number) + d * Math.min(dt * 4, 1);
      if (Math.abs(d) < 0.06) chasing.current = false;
    }
    slot.set(
      headPos.x + Math.sin(yaw.current as number) * 0.6,
      headPos.y - 0.52,
      headPos.z + Math.cos(yaw.current as number) * 0.6,
    );
    g.position.lerp(slot, Math.min(dt * 6, 1));
    g.lookAt(headPos);
    // Side panel: INDEPENDENT placement 35 degrees left at eye height, so it
    // never inherits the bar's pitch and always reads straight-on.
    if (panel.current) {
      const pa = (yaw.current as number) + 0.62;
      panelSlot.set(
        headPos.x + Math.sin(pa) * 0.85,
        headPos.y - 0.02,
        headPos.z + Math.cos(pa) * 0.85,
      );
      panel.current.position.lerp(panelSlot, Math.min(dt * 6, 1));
      panel.current.lookAt(headPos);
    }
  });

  // pointer plumbing shared by every pill and menu row
  const hp = (id: string, act: () => void) => ({
    onPointerOver: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setAim(id); },
    onPointerOut: () => setAim((a) => (a === id ? null : a)),
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); act(); },
  });
  const px = 780; // texture pixels per meter
  const pill = (wM: number, hM: number, stroke: string) =>
    roundedPanelTexture(Math.round(wM * px), Math.round(hM * px), Math.round((hM * px) / 2), stroke);

  // Side panel data: the active conversation's live agent feed + last step.
  const av = state.activeView;
  const conv = av.kind === 'conversation' ? state.conversations.find((c) => c.id === av.id) : undefined;
  const lastStep = conv?.steps[conv.steps.length - 1];
  const vrActions = (lastStep?.proposedNext ?? [])
    .filter((p) => !/^(compile-work-order|order-part:|open-ingest|show-citation:)/.test(p.action))
    .slice(0, 2);
  const PHASE_COLOR: Record<string, string> = {
    plan: '#59c2ff', retrieve: '#ffd9a0', reason: '#c792ea', tools: '#e6b455', decide: '#a3d977',
  };

  const recent = state.conversations.slice(0, 4);
  const rows: { id: string; label: string; act: () => void }[] = [
    { id: 'row-home', label: 'Home universe', act: () => { dispatch({ type: 'open-center' }); setMenuOpen(false); } },
    {
      id: 'row-preset', label: 'New diagnosis: Whirlpool E3', act: () => {
        dispatch({ type: 'new-conversation', id: crypto.randomUUID(), device: 'Whirlpool dishwasher', symptom: 'error code E3, does not heat', attachments: [] });
        setMenuOpen(false);
      },
    },
    ...recent.map((c) => ({
      id: c.id,
      label: ell(`${c.device}: ${c.symptom}`, 42),
      act: () => { dispatch({ type: 'open-conversation', id: c.id }); setMenuOpen(false); },
    })),
  ];
  const panelH = 0.16 + rows.length * 0.085;

  return (
    <>
    <group ref={group} position={[0, -0.4, 0.55]}>
      {/* MENU pill */}
      <mesh position={[-0.45, 0, 0]} {...hp('menu', () => setMenuOpen((o) => !o))}>
        <planeGeometry args={[0.16, 0.13]} />
        <meshBasicMaterial map={pill(0.16, 0.13, menuOpen ? VR_ACCENT : aim === 'menu' ? VR_AIM : VR_LINE)} transparent depthWrite={false} />
      </mesh>
      <Text font={displayFont} position={[-0.45, 0, 0.004]} fontSize={0.03} color={menuOpen ? '#ffc678' : '#c7d3de'} anchorX="center" anchorY="middle" letterSpacing={0.2}>
        MENU
      </Text>

      {/* input field pill */}
      <mesh position={[-0.02, 0, 0]} {...hp('field', onKeyboard)}>
        <planeGeometry args={[0.66, 0.13]} />
        <meshBasicMaterial map={pill(0.66, 0.13, aim === 'field' ? VR_AIM : VR_LINE)} transparent depthWrite={false} />
      </mesh>
      <Text font={displayFont} position={[-0.31, 0, 0.004]} fontSize={0.032} color={draft ? '#eaf2f9' : '#5c6b7a'} anchorX="left" anchorY="middle" maxWidth={0.58}>
        {shown || 'Message the agent...'}
      </Text>

      {/* SEND pill */}
      <mesh position={[0.45, 0, 0]} {...hp('send', onSend)}>
        <planeGeometry args={[0.2, 0.13]} />
        <meshBasicMaterial map={pill(0.2, 0.13, aim === 'send' ? VR_ACCENT : VR_LINE)} transparent depthWrite={false} />
      </mesh>
      <Text font={displayFont} position={[0.45, 0, 0.004]} fontSize={0.034} color={draft ? '#ffc678' : '#6b7885'} anchorX="center" anchorY="middle" letterSpacing={0.15}>
        SEND
      </Text>

      {/* start panel above the bar */}
      {menuOpen && (
        <group ref={menuRef} position={[-0.02, 0.12 + panelH / 2, 0.01]}>
          <mesh position={[0, 0, -0.004]}>
            <planeGeometry args={[0.74, panelH]} />
            <meshBasicMaterial map={roundedPanelTexture(577, Math.round(panelH * px), 26, VR_LINE)} transparent depthWrite={false} />
          </mesh>
          <Text font={displayFont} position={[-0.33, panelH / 2 - 0.065, 0]} fontSize={0.03} color="#8fa1b3" anchorX="left" anchorY="middle" letterSpacing={0.25}>
            {state.workspaceName.toUpperCase()}
          </Text>
          {rows.map((r, i) => {
            const y = panelH / 2 - 0.135 - i * 0.085;
            return (
              <group key={r.id} position={[0, y, 0]}>
                <mesh {...hp(r.id, r.act)}>
                  <planeGeometry args={[0.68, 0.075]} />
                  <meshBasicMaterial color="#59c2ff" transparent opacity={aim === r.id ? 0.14 : 0.02} depthWrite={false} />
                </mesh>
                <Text font={displayFont} position={[-0.32, 0, 0.004]} fontSize={0.033} color={aim === r.id ? '#eaf2f9' : '#a7b6c4'} anchorX="left" anchorY="middle" maxWidth={0.64}>
                  {r.label}
                </Text>
              </group>
            );
          })}
        </group>
      )}
    </group>

    {/* agent panel: independent side monitor, eye height, faces the user */}
    {conv && (
      <group ref={panel} position={[-0.6, 0.1, 0.75]}>
        <mesh position={[0, 0, -0.004]}>
          <planeGeometry args={[0.68, 0.92]} />
          <meshBasicMaterial map={roundedPanelTexture(530, 718, 26, VR_LINE)} transparent depthWrite={false} />
        </mesh>

        {/* header */}
        <Text font={displayFont} position={[-0.3, 0.4, 0]} fontSize={0.036} color="#eaf2f9" anchorX="left" anchorY="middle" maxWidth={0.48}>
          {conv.device.slice(0, 26)}
        </Text>
        {state.scanning && (
          <Text font={displayFont} position={[0.3, 0.4, 0]} fontSize={0.022} color="#ffc678" anchorX="right" anchorY="middle" letterSpacing={0.22}>
            ANALYZING
          </Text>
        )}
        <Text font={displayFont} position={[-0.3, 0.353, 0]} fontSize={0.022} color="#7d8ea1" anchorX="left" anchorY="middle" maxWidth={0.6}>
          {ell(conv.symptom, 54)}
        </Text>
        <mesh position={[0, 0.322, 0]}>
          <planeGeometry args={[0.6, 0.0025]} />
          <meshBasicMaterial color="#2a3644" transparent opacity={0.9} depthWrite={false} />
        </mesh>

        {/* live agent feed */}
        {state.vrLog.slice(-8).map((l, i) => (
          <group key={`${i}-${l.summary.slice(0, 8)}`} position={[0, 0.283 - i * 0.047, 0]}>
            <Text font={displayFont} position={[-0.3, 0, 0]} fontSize={0.019} color={PHASE_COLOR[l.phase] ?? '#8fa1b3'} anchorX="left" anchorY="middle" letterSpacing={0.18}>
              {l.phase.toUpperCase()}
            </Text>
            <Text font={displayFont} position={[-0.165, 0, 0]} fontSize={0.0225} color="#c7d3de" anchorX="left" anchorY="middle">
              {ell(l.summary, 40)}
            </Text>
          </group>
        ))}
        <mesh position={[0, -0.09, 0]}>
          <planeGeometry args={[0.6, 0.0025]} />
          <meshBasicMaterial color="#2a3644" transparent opacity={0.9} depthWrite={false} />
        </mesh>

        {/* verdict: instruction, confidence, guided replies */}
        {lastStep && !state.scanning && (
          <>
            <Text font={displayFont} position={[-0.3, -0.12, 0]} fontSize={0.027} color="#eaf2f9" anchorX="left" anchorY="top" maxWidth={0.6} lineHeight={1.3}>
              {ell(lastStep.instruction, 150)}
            </Text>
            <mesh position={[-0.3 + (lastStep.confidence * 0.28) / 2, -0.3, 0]}>
              <planeGeometry args={[Math.max(lastStep.confidence * 0.28, 0.01), 0.012]} />
              <meshBasicMaterial color={lastStep.confidence >= 0.7 ? '#a3d977' : lastStep.confidence >= 0.4 ? '#e6b455' : '#f07178'} transparent opacity={0.95} depthWrite={false} />
            </mesh>
            <mesh position={[-0.16, -0.3, -0.002]}>
              <planeGeometry args={[0.28, 0.012]} />
              <meshBasicMaterial color="#1b2531" transparent opacity={0.9} depthWrite={false} />
            </mesh>
            <Text font={displayFont} position={[-0.005, -0.3, 0]} fontSize={0.022} color="#8fa1b3" anchorX="left" anchorY="middle">
              {`${Math.round(lastStep.confidence * 100)}% confidence`}
            </Text>
            {vrActions.map((p, i) => (
              <group key={p.label} position={[0, -0.352 - i * 0.06, 0]}>
                <mesh {...hp(`act-${i}`, () => dispatch({ type: 'vr-outbox', text: p.action || p.label }))}>
                  <planeGeometry args={[0.6, 0.052]} />
                  <meshBasicMaterial map={pill(0.6, 0.052, aim === `act-${i}` ? VR_AIM : VR_LINE)} transparent depthWrite={false} />
                </mesh>
                <Text font={displayFont} position={[0, 0, 0.004]} fontSize={0.023} color={aim === `act-${i}` ? '#eaf2f9' : '#a7b6c4'} anchorX="center" anchorY="middle" maxWidth={0.56}>
                  {ell(p.label, 44)}
                </Text>
              </group>
            ))}
          </>
        )}
      </group>
    )}
    </>
  );
}

/** VR-only atmosphere: mid-field dust, extra nebulas, and a faint anchor
 *  ring at the user's feet for perceptive stability. */
function VRAmbiance() {
  const dust = useMemo(() => {
    const arr = new Float32Array(420 * 3);
    for (let i = 0; i < 420; i++) {
      const r = 4.5 + Math.abs(rnd(i * 5.1)) * 7;
      const th = rnd(i * 1.7) * Math.PI * 2;
      arr[i * 3] = Math.cos(th) * r;
      arr[i * 3 + 1] = rnd(i * 3.3) * 4;
      arr[i * 3 + 2] = Math.sin(th) * r;
    }
    return arr;
  }, []);
  const nebulaWarm = useMemo(() => radialSprite('120, 78, 40'), []);
  const nebulaTeal = useMemo(() => radialSprite('36, 92, 104'), []);
  return (
    <group>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dust, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#7d8ea1" size={0.028} sizeAttenuation transparent opacity={0.55} depthWrite={false} />
      </points>
      <sprite position={[8, 5, 14]} scale={[26, 26, 1]}>
        <spriteMaterial map={nebulaWarm} transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <sprite position={[-12, -3, 18]} scale={[24, 24, 1]}>
        <spriteMaterial map={nebulaTeal} transparent opacity={0.35} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <group position={[VR_EYE.x, VR_SPAWN.y + 0.01, VR_EYE.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <ringGeometry args={[0.34, 0.35, 64]} />
          <meshBasicMaterial color="#59c2ff" transparent opacity={0.16} depthWrite={false} />
        </mesh>
        <mesh>
          <ringGeometry args={[0.6, 0.607, 64]} />
          <meshBasicMaterial color="#59c2ff" transparent opacity={0.09} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

/** A raw file materializing near the core while the agent reads it:
 *  a white holographic embryo card, struck by analysis lightning. */
const EMBRYO_POS = new THREE.Vector3(0.85, 0.42, 0.55);

function IngestEmbryo() {
  const mesh = useRef<THREE.Mesh>(null);
  const holo = fileCardTexture('#ffd9a0');
  useFrame(({ clock }) => {
    if (!mesh.current) return;
    const t = clock.elapsedTime;
    mesh.current.scale.setScalar(1 + Math.sin(t * 6) * 0.06);
    (mesh.current.material as THREE.MeshBasicMaterial).opacity = 0.75 + Math.sin(t * 9) * 0.2;
  });
  return (
    <group position={EMBRYO_POS}>
      <Billboard>
        <mesh ref={mesh}>
          <planeGeometry args={[0.34, 0.425]} />
          <meshBasicMaterial map={holo} transparent depthWrite={false} color="#ffffff" blending={THREE.AdditiveBlending} />
        </mesh>
        <Text font={displayFont} position={[0, -0.32, 0]} fontSize={0.075} color="#ffc678" anchorX="center" letterSpacing={0.2} outlineWidth={0.004} outlineColor="#080b10">
          ANALYZING
        </Text>
      </Billboard>
    </group>
  );
}

/* ---------- the agent core ---------- */

function AgentCore({ scanning }: { scanning: boolean }) {
  const halo = useRef<THREE.Sprite>(null);
  const nucleus = useRef<THREE.Mesh>(null);
  const gyroA = useRef<THREE.Group>(null);
  const gyroB = useRef<THREE.Group>(null);
  const gyroC = useRef<THREE.Group>(null);
  const orbiters = useRef<THREE.Points>(null);
  const haloMap = useMemo(() => radialSprite('255, 178, 92'), []);
  const glassMat = useMemo(() => makeGlassShellMaterial(), []);
  useEffect(() => () => glassMat.dispose(), [glassMat]);

  const orbiterGeom = useMemo(() => {
    const n = 42;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.34 + (i % 5) * 0.035;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = Math.sin(a * 3.1) * 0.05;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    return arr;
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (halo.current) {
      halo.current.scale.setScalar(scanning ? 1.5 + Math.sin(t * 3.2) * 0.1 : 1.35 + Math.sin(t * 1.1) * 0.07);
    }
    if (nucleus.current) nucleus.current.scale.setScalar(scanning ? 1.12 + Math.sin(t * 11) * 0.06 : 1);
    glassMat.uniforms.uIntensity.value = scanning ? 0.85 + Math.sin(t * 7) * 0.1 : 0.45 + Math.sin(t * 1.6) * 0.06;
    // gyroscope: three thin rings precessing on different axes
    if (gyroA.current) { gyroA.current.rotation.x = t * 0.42; gyroA.current.rotation.y = t * 0.18; }
    if (gyroB.current) { gyroB.current.rotation.y = -t * 0.31; gyroB.current.rotation.z = t * 0.22; }
    if (gyroC.current) { gyroC.current.rotation.z = t * 0.15; gyroC.current.rotation.x = -t * 0.26; }
    if (orbiters.current) orbiters.current.rotation.y = t * 0.5;
  });

  return (
    <group>
      {/* white-hot nucleus in a warm shell */}
      <mesh ref={nucleus}>
        <sphereGeometry args={[0.085, 24, 24]} />
        <meshBasicMaterial color="#fff7ea" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.15, 24, 24]} />
        <meshBasicMaterial color="#ffb454" transparent opacity={0.28} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <sprite ref={halo} scale={[1.35, 1.35, 1]}>
        <spriteMaterial map={haloMap} transparent opacity={0.75} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* precessing gyroscope rings */}
      <group ref={gyroA}>
        <mesh>
          <torusGeometry args={[0.24, 0.0035, 8, 96]} />
          <meshBasicMaterial color="#ffd9a0" transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>
      <group ref={gyroB}>
        <mesh>
          <torusGeometry args={[0.3, 0.0028, 8, 96]} />
          <meshBasicMaterial color="#59c2ff" transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>
      <group ref={gyroC}>
        <mesh>
          <torusGeometry args={[0.37, 0.0022, 8, 96]} />
          <meshBasicMaterial color="#ffb454" transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {/* close-orbit particles */}
      <points ref={orbiters}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[orbiterGeom, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#ffd9a0" size={0.014} transparent opacity={0.8} depthWrite={false} blending={THREE.AdditiveBlending} sizeAttenuation />
      </points>

      {/* glass shell + contained plasma filaments */}
      <mesh material={glassMat}>
        <sphereGeometry args={[0.46, 48, 48]} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <PlasmaFilament key={i} radius={0.44} seed={i * 2.7 + 1} active={scanning} />
      ))}

      <pointLight intensity={40} distance={26} color="#ffd9a0" />
      <Billboard position={[0, -0.58, 0]}>
        <Text font={displayFont} fontSize={0.082} color="#b9884e" letterSpacing={0.5} anchorX="center" outlineWidth={0.003} outlineColor="#080b10">
          AGENT
        </Text>
      </Billboard>
    </group>
  );
}

/* ---------- documents ---------- */

interface FileNode {
  doc: Document;
  color: string;
  pos: THREE.Vector3;
  catIndex: number;
  sparks: [number, number, number][];
}

function FileCard({ node, targetPos, ghost, bornAtCore, isHit, hitCount, onHover, onSelect, sizeMul = 1, vr = false, onMoved, disabled = false }: {
  node: FileNode;
  targetPos: THREE.Vector3;
  ghost: boolean;
  bornAtCore: boolean;
  isHit: boolean;
  hitCount: number;
  onHover: (h: { doc: Document; x: number; y: number } | null) => void;
  onSelect: (docId: string) => void;
  sizeMul?: number;
  vr?: boolean;
  onMoved?: (docId: string, pos: THREE.Vector3, done: boolean) => void;
  disabled?: boolean;
}) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const root = useRef<THREE.Group>(null);
  const seed = node.doc.id.length + node.catIndex * 7;
  const [aimed, setAimed] = useState(false);
  // VR grab: trigger-hold drags the card along the ray, release drops it.
  // Same capture quirk as pages: re-baseline on first move, judge at release.
  const dragOff = useRef<THREE.Vector3 | null>(null);
  const dragFresh = useRef(false);
  const grabWorld = useRef(new THREE.Vector3());
  const tmpWorld = useRef(new THREE.Vector3());
  const wasDrag = useRef(false);
  const dragPointer = useRef<number | null>(null);

  useFrame(({ clock }, dt) => {
    // Contextual recursion: the universe recomposes — scoped files migrate
    // toward the core, everything else fades to a distant ghost.
    if (root.current) {
      if (!dragOff.current) root.current.position.lerp(targetPos, Math.min(dt * 2.6, 1));
      const s = sizeMul * (aimed && !ghost ? 1.15 : 1);
      root.current.scale.lerp(_cardScale.setScalar(s), Math.min(dt * 5, 1));
    }
    if (!mat.current) return;
    const t = clock.elapsedTime;
    const hasCover = !!cover;
    let base = ghost ? (aimed && vr ? 0.5 : vr ? 0.16 : hasCover ? 0.08 : 0.06) : isHit ? 1 : hasCover ? 0.95 : 0.68;
    if (aimed && !ghost) base = Math.max(base, 0.98);
    const flicker = ghost || hasCover ? 0 : Math.sin(t * (1.6 + (seed % 3) * 0.5) + seed) * 0.1;
    mat.current.opacity = base + flicker;
  });

  // Real face of the document: its first page (or the video thumbnail).
  const cover = useCachedTexture(node.doc.pages[0]?.imageUrl || undefined);

  const isVideo = node.doc.format === 'video';
  const holo = fileCardTexture(node.color);
  const k = isHit ? 1.35 : 1;
  const dims: [number, number] = isVideo ? [0.38 * k, 0.285 * k] : [0.3 * k, 0.39 * k];

  return (
    <group ref={root} position={bornAtCore ? EMBRYO_POS : node.pos}>
      <Billboard>
        {/* category-tinted frame behind the real cover */}
        {cover && (
          <mesh position={[0, 0, -0.005]}>
            <planeGeometry args={[dims[0] + 0.022, dims[1] + 0.022]} />
            <meshBasicMaterial color={node.color} transparent opacity={ghost ? 0.05 : isHit ? 1 : 0.75} depthWrite={false} />
          </mesh>
        )}
        <mesh key={cover ? 'cover' : 'holo'}>
          <planeGeometry args={dims} />
          {cover ? (
            <meshBasicMaterial ref={mat} map={cover} transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
          ) : (
            <meshBasicMaterial
              ref={mat}
              map={holo}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
              color={isHit ? '#ffffff' : node.color}
              blending={THREE.AdditiveBlending}
            />
          )}
        </mesh>
        {/* Enlarged invisible hit target: a finger-sized raycast zone (and a
            more forgiving hover on desktop). ALL interaction lives here. */}
        <mesh
          position={[0, 0, 0.004]}
          onPointerOver={(e) => {
            if (disabled || (ghost && !vr)) return;
            e.stopPropagation();
            setAimed(true);
            if (!vr) { onHover({ doc: node.doc, x: e.clientX ?? 0, y: e.clientY ?? 0 }); document.body.style.cursor = 'pointer'; }
          }}
          onPointerOut={() => {
            if (ghost && !vr) return;
            setAimed(false);
            if (!vr) { onHover(null); document.body.style.cursor = ''; }
          }}
          onPointerDown={(e) => {
            if (disabled || !vr || !onMoved || !root.current) return;
            if (dragPointer.current !== null) return; // one hand owns the grab
            e.stopPropagation();
            (e.target as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture(e.pointerId);
            dragPointer.current = e.pointerId;
            // world-space grab offset: the card may live in a rotated group
            root.current.getWorldPosition(grabWorld.current);
            dragOff.current = grabWorld.current.clone().sub(e.point);
            dragFresh.current = true;
            wasDrag.current = false;
          }}
          onPointerMove={(e) => {
            // BOTH controller rays send moves; only the grabbing one may drag,
            // or the card jumps between the two lasers.
            if (e.pointerId !== dragPointer.current) return;
            if (!dragOff.current || !root.current?.parent || !onMoved) return;
            if (dragFresh.current) {
              root.current.getWorldPosition(tmpWorld.current);
              dragOff.current.copy(tmpWorld.current).sub(e.point);
              dragFresh.current = false;
              return;
            }
            const wp = e.point.clone().add(dragOff.current);
            root.current.parent.worldToLocal(wp);
            root.current.position.copy(wp);
            onMoved(node.doc.id, root.current.position, false);
          }}
          onPointerUp={(e) => {
            if (e.pointerId !== dragPointer.current) return;
            dragPointer.current = null;
            if (!dragOff.current || !root.current || !onMoved) return;
            dragOff.current = null;
            (e.target as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(e.pointerId);
            root.current.getWorldPosition(tmpWorld.current);
            wasDrag.current = tmpWorld.current.distanceTo(grabWorld.current) > 0.25;
            // Micro-move = a trigger click with hand shake: snap back, never
            // commit. Accidental pinning was scattering cards everywhere.
            if (!wasDrag.current) root.current.position.copy(grabWorld.current);
            onMoved(node.doc.id, root.current.position, true);
          }}
          onClick={(e) => {
            if (disabled || (ghost && !vr)) return;
            e.stopPropagation();
            if (wasDrag.current) { wasDrag.current = false; return; } // a drop is not a click
            onSelect(node.doc.id);
          }}
        >
          <planeGeometry args={[dims[0] * 1.5, dims[1] * 1.5]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} side={THREE.DoubleSide} />
        </mesh>
        {isVideo && !ghost && (
          <sprite position={[0, 0, 0.01]} scale={[0.11, 0.11, 1]}>
            <spriteMaterial map={playBadge()} transparent depthWrite={false} />
          </sprite>
        )}
        {node.doc.origin === 'session' && (
          <mesh position={[0, 0, -0.01]}>
            <ringGeometry args={[0.3, 0.315, 32]} />
            <meshBasicMaterial color="#ffb454" transparent opacity={0.85} depthWrite={false} />
          </mesh>
        )}
        {!ghost && isHit && (
          <Text
            font={displayFont}
            position={[0, -0.33, 0]}
            fontSize={0.095}
            color="#ffffff"
            anchorX="center"
            outlineWidth={0.005}
            outlineColor="#080b10"
          >
            {node.doc.model.split('(')[0].trim().slice(0, 26)}
          </Text>
        )}
        {isHit && hitCount > 0 && (
          <Text font={displayFont} position={[0, 0.35, 0]} fontSize={0.085} color="#ffc678" anchorX="center" outlineWidth={0.005} outlineColor="#080b10">
            {`${hitCount} page${hitCount > 1 ? 's' : ''} cited`}
          </Text>
        )}
      </Billboard>

      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(node.sparks.flat()), 3]} />
        </bufferGeometry>
        <pointsMaterial
          color={isHit ? '#ffffff' : node.color}
          size={isHit ? 0.04 : 0.024}
          transparent
          opacity={ghost ? 0.05 : isHit ? 0.9 : 0.42}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
        />
      </points>
    </group>
  );
}

/* ---------- the agent reads: real manual pages fan out in space ---------- */

const PLAY_SHAPE = (() => {
  const sh = new THREE.Shape();
  sh.moveTo(-0.022, 0.036);
  sh.lineTo(-0.022, -0.036);
  sh.lineTo(0.042, 0);
  sh.closePath();
  return sh;
})();

/** The parent document as a mini card (cover + name), one click closes the
 *  current view. `file` variant adds stacked sheets behind the cover and a
 *  FILE badge: unmistakably THE document, not one of its pages; its texts sit
 *  ABOVE the cover so the card can dock right over the page grid. */
function DocChip({ chip, x, file = false, sub }: { chip: DocChipInfo; x: number; file?: boolean; sub?: string }) {
  const [aim, setAim] = useState(false);
  const cover = useCachedTexture(chip.coverUrl);
  const W = 0.24;
  const H = 0.31;
  return (
    <group position={[x, 0.02, 0.01]}>
      {file && (
        <>
          <mesh position={[0.035, 0.03, -0.012]} rotation={[0, 0, -0.07]}>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial color="#26313d" transparent opacity={0.9} depthWrite={false} />
          </mesh>
          <mesh position={[0.07, 0.06, -0.02]} rotation={[0, 0, -0.14]}>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial color="#1a242f" transparent opacity={0.75} depthWrite={false} />
          </mesh>
        </>
      )}
      <mesh position={[0, 0, -0.004]}>
        <planeGeometry args={[W + 0.024, H + 0.024]} />
        <meshBasicMaterial color={aim ? '#59c2ff' : chip.color} transparent opacity={aim ? 1 : 0.8} depthWrite={false} />
      </mesh>
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); setAim(true); }}
        onPointerOut={() => setAim(false)}
        onClick={(e) => { e.stopPropagation(); chip.onGo(); }}
      >
        <planeGeometry args={[W, H]} />
        {cover
          ? <meshBasicMaterial map={cover} toneMapped={false} transparent />
          : <meshBasicMaterial color="#141d28" transparent opacity={0.92} depthWrite={false} />}
      </mesh>
      {file ? (
        <>
          <Text font={displayFont} position={[0, H / 2 + 0.14, 0]} fontSize={0.05} color="#c7d3de" anchorX="center" maxWidth={0.7} textAlign="center" outlineWidth={0.003} outlineColor="#080b10">
            {chip.label}
          </Text>
          <Text font={displayFont} position={[0, H / 2 + 0.062, 0]} fontSize={0.042} color={aim ? '#59c2ff' : '#8fa1b3'} anchorX="center" letterSpacing={0.16} outlineWidth={0.003} outlineColor="#080b10">
            {aim ? 'CLOSE' : `FILE${sub ? ` · ${sub}` : ''}`}
          </Text>
        </>
      ) : (
        <>
          <Text font={displayFont} position={[0, -H / 2 - 0.055, 0]} fontSize={0.042} color={aim ? '#59c2ff' : '#93a3b3'} anchorX="center" maxWidth={0.5} textAlign="center" outlineWidth={0.003} outlineColor="#080b10">
            {chip.label}
          </Text>
          <Text font={displayFont} position={[0, -H / 2 - 0.12, 0]} fontSize={0.036} color={aim ? '#59c2ff' : '#66788a'} anchorX="center" letterSpacing={0.16}>
            CLOSE
          </Text>
        </>
      )}
    </group>
  );
}

interface DocChipInfo { label: string; color: string; coverUrl?: string; onGo: () => void }

function FloatingPage({ url, label, title, index, total, anchor, color, onClick, overrideTarget, scaleMul = 1, onAimChange, onPinned, pinned = false, zoomed = false, onNav, navLabel, zoomMul = 1, onZoomMul, spawnWorld, docChip }: {
  url: string; label?: string; title?: string; index: number; total: number; anchor: THREE.Vector3; color: string; onClick: () => void;
  overrideTarget?: THREE.Vector3; scaleMul?: number; onAimChange?: (over: boolean) => void;
  onPinned?: (world: THREE.Vector3) => void; pinned?: boolean; zoomed?: boolean;
  onNav?: (dir: 1 | -1) => void; navLabel?: string;
  zoomMul?: number; onZoomMul?: (delta: number) => void;
  /** World point the page FLIES from on mount (its source document): spatial
   *  continuity — the eye tracks where evidence comes from. */
  spawnWorld?: THREE.Vector3;
  /** Focus mode: parent doc mini-card at the page's side (close affordance). */
  docChip?: DocChipInfo;
}) {
  const tex = useCachedTexture(url);
  const [aimL, setAimL] = useState(false);
  const [aimR, setAimR] = useState(false);
  const [aimPlus, setAimPlus] = useState(false);
  const [aimMinus, setAimMinus] = useState(false);
  const group = useRef<THREE.Group>(null);
  const born = useRef(0);
  // A page mounted straight INTO focus (arrow flip) has never billboarded:
  // frozen at birth it faces AWAY from the user — invisible and unclickable
  // (front-side raycast culling). Give it one frame of follow to face the
  // head, then freeze as usual so buttons stay still under the aim.
  const [oriented, setOriented] = useState(false);
  useEffect(() => { if (!zoomed) setOriented(false); }, [zoomed]);

  // VR: hold-and-move rips the page out of the arc and pins it in the world.
  // Capture recomputes e.point with a different parametrization than the
  // initial hit, so: re-baseline the offset on the FIRST captured move, and
  // decide click-vs-drag at release from the REAL world displacement.
  const dragOff = useRef<THREE.Vector3 | null>(null);
  const dragFresh = useRef(false);
  const grabWorld = useRef(new THREE.Vector3());
  const tmpWorld = useRef(new THREE.Vector3());
  const wasDrag = useRef(false);
  const dragPointer = useRef<number | null>(null);
  // mm:ss label only exists on video segments: frames are 16:9, pages portrait
  const video = !!label;
  const W = video ? 0.82 : 0.54;
  const H = video ? 0.46 : 0.72;

  // The group's position is owned ENTIRELY by imperative code (this effect +
  // useFrame). Passing it as a JSX prop would let any re-render (a hover, an
  // aim-count change) snap the page back to its slot mid-zoom or mid-drag:
  // the "page reloads on every move" bug.
  // Fly-in start point: before first paint, park the page at its source doc
  // (converted to rig-local); the slot lerp then carries it into the arc.
  const spawned = useRef(false);
  useLayoutEffect(() => {
    if (spawned.current) return;
    const g = group.current;
    if (!g) return;
    spawned.current = true;
    if (zoomed && !pinned && overrideTarget) {
      // Page FLIP: born straight into focus. A reader's frame must not move:
      // appear exactly at the reading slot, full size, no travel, no pop.
      g.position.copy(VR_READ_SLOT);
      g.scale.setScalar(scaleMul * 1.85 * zoomMul);
      born.current = -1; // pop already done
    } else if (spawnWorld && overrideTarget && g.parent) {
      g.parent.updateWorldMatrix(true, false);
      g.position.copy(g.parent.worldToLocal(spawnWorld.clone()));
    } else {
      g.position.copy(target);
    }
  });

  const target = useMemo(() => {
    if (overrideTarget) return overrideTarget;
    const up = anchor.clone().normalize();
    const side = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).normalize();
    // Arrival-order slots alternate around the doc (0, +1, -1, +2, ...): a
    // card that is already placed NEVER moves when later citations arrive.
    const spread = (index % 2 === 0 ? 1 : -1) * Math.ceil(index / 2) * 0.6;
    return anchor.clone()
      .addScaledVector(up, 0.78 + Math.abs(spread) * 0.08)
      .addScaledVector(side, spread);
  }, [anchor, index, overrideTarget]);

  useFrame(({ clock }, dt) => {
    if (!group.current) return;
    if (zoomed && !oriented) setOriented(true);
    if (born.current === 0) born.current = clock.elapsedTime;
    const k = Math.min((clock.elapsedTime - born.current) / 0.25, 1);
    const pop = 0.86 + (1 - Math.pow(1 - k, 3)) * 0.14;
    if (overrideTarget) {
      if (dragOff.current) return; // hand carries the page, no slot pull
      // VR arc: slots slide as new evidence arrives, so glide instead of snap;
      // a zoomed page pulls in close for ACTUAL reading (rig-local: the head
      // sits at the rig origin; pinned pages just scale in place).
      // Reading distance floor: the page must NEVER engulf the controllers,
      // or the rays start behind its plane and nothing is clickable.
      let pt = target;
      if (zoomed && !pinned) pt = VR_READ_SLOT;
      group.current.position.lerp(pt, Math.min(dt * 5, 1));
      const s = scaleMul * (zoomed ? 1.85 * zoomMul : 1) * pop;
      group.current.scale.lerp(_cardScale.setScalar(s), Math.min(dt * 6, 1));
      return;
    }
    // No travel, no bobbing, no re-centering: the card pops in AT its slot
    // (quick scale-in) and then holds perfectly still. Frozen-world rule.
    group.current.position.copy(target);
    group.current.scale.setScalar(pop);
  });

  if (!tex) {
    // Focused page still loading: keep a visible frame and the exit surface
    // alive, or the user stares at pure black with nothing to click.
    if (!zoomed) return null;
    return (
      <group ref={group}>
        <Billboard>
          <mesh position={[0, 0, -0.25]} onClick={(e) => { e.stopPropagation(); onClick(); }}>
            <planeGeometry args={[16, 16]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <mesh>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial color={color} transparent opacity={0.14} depthWrite={false} />
          </mesh>
        </Billboard>
      </group>
    );
  }
  return (
    <group ref={group}>
      {/* follow off while reading: a page that keeps re-facing the head makes
          its buttons drift under the aim */}
      <Billboard follow={!zoomed || !oriented}>
        {/* Focus veil: a big dark backdrop right BEHIND the page. Plain depth
            sorting hides the world behind it while hands, rays and the page
            (all closer) stay naturally in front. Clicking it closes focus. */}
        {/* Invisible click-catcher: exit focus by clicking anywhere around the
            page. NO visible veil — the universe is already hidden in focus,
            and any finite world-anchored dark quad shows its edges the moment
            the head turns. The starfield IS the theater backdrop. */}
        {zoomed && (
          <mesh position={[0, 0, -0.25]} onClick={(e) => { e.stopPropagation(); onClick(); }}>
            <planeGeometry args={[16, 16]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        )}
        <mesh position={[0, 0, -0.004]}>
          <planeGeometry args={[W + 0.02, H + 0.02]} />
          <meshBasicMaterial color={video ? '#ffb454' : color} transparent opacity={video ? 0.7 : 0.55} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
        <mesh
          onClick={(e) => {
            e.stopPropagation();
            if (wasDrag.current) { wasDrag.current = false; return; } // a drop is not a click
            onClick();
          }}
          onPointerOver={(e) => { if (onAimChange) { e.stopPropagation(); onAimChange(true); } }}
          onPointerOut={() => onAimChange?.(false)}
          onPointerDown={(e) => {
            if (!overrideTarget || !onPinned || !group.current) return;
            if (dragPointer.current !== null) return; // one hand owns the grab
            e.stopPropagation();
            (e.target as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture(e.pointerId);
            dragPointer.current = e.pointerId;
            group.current.getWorldPosition(grabWorld.current);
            dragOff.current = grabWorld.current.clone().sub(e.point);
            dragFresh.current = true;
            wasDrag.current = false;
          }}
          onPointerMove={(e) => {
            // BOTH controller rays send moves; only the grabbing one may drag,
            // or the page jumps between the two lasers.
            if (e.pointerId !== dragPointer.current) return;
            if (!dragOff.current || !group.current?.parent) return;
            if (dragFresh.current) {
              // first captured move: re-baseline, do NOT displace
              group.current.getWorldPosition(tmpWorld.current);
              dragOff.current.copy(tmpWorld.current).sub(e.point);
              dragFresh.current = false;
              return;
            }
            const wp = e.point.clone().add(dragOff.current);
            group.current.parent.worldToLocal(wp);
            group.current.position.copy(wp);
          }}
          onPointerUp={(e) => {
            if (e.pointerId !== dragPointer.current) return;
            dragPointer.current = null;
            if (!dragOff.current || !group.current) return;
            dragOff.current = null;
            (e.target as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(e.pointerId);
            group.current.getWorldPosition(tmpWorld.current);
            wasDrag.current = tmpWorld.current.distanceTo(grabWorld.current) > 0.25;
            if (wasDrag.current && onPinned) onPinned(tmpWorld.current.clone());
          }}
        >
          <planeGeometry args={[W, H]} />
          {/* transparent: keeps the page in the transparent render pass, so
              focus mode's renderOrder actually wins over the dimmer dome */}
          <meshBasicMaterial map={tex} toneMapped={false} transparent />
        </mesh>
        {video && (
          <group position={[0, 0, 0.004]}>
            {/* play badge, cinema-style */}
            <mesh>
              <circleGeometry args={[0.088, 40]} />
              <meshBasicMaterial color="#05070a" transparent opacity={0.55} depthWrite={false} />
            </mesh>
            <mesh>
              <ringGeometry args={[0.082, 0.09, 48]} />
              <meshBasicMaterial color="#ffffff" transparent opacity={0.9} depthWrite={false} />
            </mesh>
            <mesh position={[0.004, 0, 0.001]}>
              <shapeGeometry args={[PLAY_SHAPE]} />
              <meshBasicMaterial color="#ffffff" transparent opacity={0.95} depthWrite={false} />
            </mesh>
            {/* timestamp chip inside the frame */}
            <mesh position={[-W / 2 + 0.1, -H / 2 + 0.062, 0]}>
              <planeGeometry args={[0.16, 0.076]} />
              <meshBasicMaterial color="#05070a" transparent opacity={0.72} depthWrite={false} />
            </mesh>
            <Text font={displayFont} position={[-W / 2 + 0.1, -H / 2 + 0.062, 0.001]} fontSize={0.048} color="#ffc678" anchorX="center" anchorY="middle">
              {label}
            </Text>
          </group>
        )}
        {title && (
          <Text font={displayFont} position={[0, -(H / 2) - 0.08, 0]} fontSize={0.062} color={video ? '#c7d3de' : '#93a3b3'} anchorX="center" outlineWidth={0.004} outlineColor="#080b10" maxWidth={0.9} textAlign="center">
            {title}
          </Text>
        )}
        {/* focus mode: flip through the document without leaving the page */}
        {zoomed && onNav && (
          <>
            <mesh
              position={[-(W / 2) - 0.14, 0, 0.01]}
              onPointerOver={(e) => { e.stopPropagation(); setAimL(true); }}
              onPointerOut={() => setAimL(false)}
              onClick={(e) => { e.stopPropagation(); onNav(-1); }}
            >
              <circleGeometry args={[0.09, 32]} />
              <meshBasicMaterial color={aimL ? '#59c2ff' : '#141d28'} transparent opacity={0.92} depthWrite={false} />
            </mesh>
            <Text font={displayFont} position={[-(W / 2) - 0.14, 0, 0.014]} fontSize={0.08} color={aimL ? '#0b1118' : '#c7d3de'} anchorX="center" anchorY="middle">
              {'<'}
            </Text>
            <mesh
              position={[W / 2 + 0.14, 0, 0.01]}
              onPointerOver={(e) => { e.stopPropagation(); setAimR(true); }}
              onPointerOut={() => setAimR(false)}
              onClick={(e) => { e.stopPropagation(); onNav(1); }}
            >
              <circleGeometry args={[0.09, 32]} />
              <meshBasicMaterial color={aimR ? '#59c2ff' : '#141d28'} transparent opacity={0.92} depthWrite={false} />
            </mesh>
            <Text font={displayFont} position={[W / 2 + 0.14, 0, 0.014]} fontSize={0.08} color={aimR ? '#0b1118' : '#c7d3de'} anchorX="center" anchorY="middle">
              {'>'}
            </Text>
            {navLabel && (
              <Text font={displayFont} position={[0, -(H / 2) - 0.16, 0.01]} fontSize={0.05} color="#8fa1b3" anchorX="center" letterSpacing={0.1}>
                {navLabel}
              </Text>
            )}
          </>
        )}
        {/* focus mode: laser zoom, since you cannot lean in with a mouse */}
        {zoomed && onZoomMul && (
          <>
            <mesh
              position={[W / 2 + 0.14, 0.26, 0.01]}
              onPointerOver={(e) => { e.stopPropagation(); setAimPlus(true); }}
              onPointerOut={() => setAimPlus(false)}
              onClick={(e) => { e.stopPropagation(); onZoomMul(0.35); }}
            >
              <circleGeometry args={[0.09, 32]} />
              <meshBasicMaterial color={aimPlus ? '#ffb454' : '#141d28'} transparent opacity={0.92} depthWrite={false} />
            </mesh>
            <Text font={displayFont} position={[W / 2 + 0.14, 0.26, 0.014]} fontSize={0.08} color={aimPlus ? '#0b1118' : '#c7d3de'} anchorX="center" anchorY="middle">
              +
            </Text>
            <mesh
              position={[W / 2 + 0.14, -0.26, 0.01]}
              onPointerOver={(e) => { e.stopPropagation(); setAimMinus(true); }}
              onPointerOut={() => setAimMinus(false)}
              onClick={(e) => { e.stopPropagation(); onZoomMul(-0.35); }}
            >
              <circleGeometry args={[0.09, 32]} />
              <meshBasicMaterial color={aimMinus ? '#ffb454' : '#141d28'} transparent opacity={0.92} depthWrite={false} />
            </mesh>
            <Text font={displayFont} position={[W / 2 + 0.14, -0.26, 0.014]} fontSize={0.09} color={aimMinus ? '#0b1118' : '#c7d3de'} anchorX="center" anchorY="middle">
              -
            </Text>
          </>
        )}
        {zoomed && docChip && <DocChip chip={docChip} x={W / 2 + 0.52} />}
      </Billboard>
    </group>
  );
}

/* ---------- camera: the agent drives the eye ---------- */

function CameraRig({ focus, panelOpen, idle }: { focus: THREE.Vector3 | null; panelOpen: boolean; idle: boolean }) {
  const { camera, size } = useThree();
  const controls = useRef<any>(null);

  // Chat panel covers the left half: shift the RENDER, not the camera target.
  // setViewOffset has no feedback loop, so the camera can truly come to rest
  // (the old camera-space shift orbited forever and made the cards drift).
  const viewX = useRef(0);
  const settling = useRef(true);
  const focusKey = useRef('__init__');
  const dragging = useRef(false); // pause the ambient orbit while the user drags
  const spinTarget = useRef(0);   // idle-orbit angle advancing with real time
  const spinAngle = useRef(0);    // applied angle, eased toward the target
  useFrame((_, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const wantX = panelOpen ? -Math.min(640, size.width * 0.46) / 2 : 0;
    if (Math.abs(viewX.current - wantX) > 0.5) {
      viewX.current = THREE.MathUtils.lerp(viewX.current, wantX, Math.min(dt * 5, 1));
      cam.setViewOffset(size.width, size.height, viewX.current, 0, size.width, size.height);
    } else if (viewX.current !== wantX) {
      viewX.current = wantX; // settle exactly, then never touch it again
      if (wantX === 0) cam.clearViewOffset();
      else cam.setViewOffset(size.width, size.height, wantX, 0, size.width, size.height);
    }

    if (!controls.current) return;
    const c = controls.current;

    // The rig only OWNS the camera while flying to a new focus. Once settled
    // it lets go for good, so a user's pinch-zoom or orbit is never fought
    // frame by frame (the frozen-world rule, extended to the distance).
    const key = focus ? `${focus.x.toFixed(2)},${focus.y.toFixed(2)},${focus.z.toFixed(2)}` : 'none';
    if (key !== focusKey.current) { focusKey.current = key; settling.current = true; }

    // Ambient drift: a gentle, diagonal camera orbit around the agent when the
    // universe is idle. The target angle advances with real time; the applied
    // angle eases toward it (low-pass), so the scene's frame dips don't land as
    // one visible jump and the stop (when `idle` drops) is a quick ease-out, not
    // a hard cut. Paused while the user drags and while flying to a focus. We
    // orbit the CAMERA, not the world, so every doc's world position (and its
    // bolts / pages) stays aligned.
    if (idle && !settling.current && !dragging.current) {
      spinTarget.current += IDLE_SPIN_RATE * dt;
    }
    if (!settling.current && !dragging.current) {
      const prevSpin = spinAngle.current;
      spinAngle.current = spinTarget.current
        + (prevSpin - spinTarget.current) * Math.exp(-IDLE_SPIN_SMOOTH * dt);
      const dTheta = spinAngle.current - prevSpin;
      if (Math.abs(dTheta) > 1e-7) {
        const off = _camOff.copy(camera.position).sub(c.target);
        off.applyAxisAngle(IDLE_AXIS, dTheta);
        camera.position.copy(c.target).add(off);
        c.update();
      }
    }

    if (!settling.current) return;

    const lookTarget = focus ? focus.clone().multiplyScalar(0.82) : new THREE.Vector3(0, 0, 0);
    const wantDist = focus ? 6.2 : 10.2;
    const dir = new THREE.Vector3().subVectors(camera.position, c.target);

    // At rest, STOP: an asymptotic lerp never truly arrives, and billboarded
    // cards re-face the drifting camera forever.
    const targetErr = c.target.distanceTo(lookTarget);
    const distErr = Math.abs(dir.length() - wantDist);
    if (targetErr < 0.005 && distErr < 0.01) { settling.current = false; return; }

    c.target.lerp(lookTarget, Math.min(dt * 2.4, 1));
    const newDist = THREE.MathUtils.lerp(dir.length(), wantDist, Math.min(dt * 1.6, 1));
    camera.position.copy(c.target.clone().addScaledVector(dir.normalize(), newDist));
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      onStart={() => { dragging.current = true; }}
      onEnd={() => { dragging.current = false; }}
      minDistance={5}
      maxDistance={18}
      maxPolarAngle={Math.PI * 0.72}
      minPolarAngle={Math.PI * 0.18}
    />
  );
}

/* ---------- scene ---------- */

function Scene({ panelOpen, scopeIds, hovering, onHover, onSelect, onOpenPage, vrDraft, onVrKeyboard, onVrSend }: {
  panelOpen: boolean;
  scopeIds: Set<string> | null;
  hovering: boolean;
  onHover: (h: { doc: Document; x: number; y: number } | null) => void;
  onSelect: (docId: string) => void;
  onOpenPage: (docId: string, page: number) => void;
  vrDraft: string;
  onVrKeyboard: () => void;
  onVrSend: () => void;
}) {
  const { state, docs } = useApp();
  const vr = useXR((s) => s.mode) === 'immersive-vr';
  // In VR, clicking a file fans its pages into the evidence arc; the agent's
  // own retrievals reclaim the arc as soon as they arrive.
  const [vrDoc, setVrDoc] = useState<string | null>(null);
  useEffect(() => { if (state.highlight.length > 0) setVrDoc(null); }, [state.highlight]);
  // Evidence rig freezes while a page is aimed.
  const [arcAim, setArcAim] = useState(0);
  // Lightbox focus: ONE page at a time; the rest of the universe dims.
  const [zoomKey, setZoomKey] = useState<string | null>(null);
  // Doc fan window: 6 pages at a time, paged with arrows or focus-nav.
  // Reset happens where a doc is OPENED (card click), not in an effect on
  // vrDoc: pinned-page nav opens a doc AND targets a specific window, and an
  // effect reset would clobber it right after.
  const [fanOffset, setFanOffset] = useState(0);
  // Pages fly OUT of their planet only when the content source changes (doc
  // opened, agent retrieval); paging a window or leaving focus repositions
  // in place — a page flip should not launch six planets' worth of travel.
  const prevVrDoc = useRef<string | null>(null);
  const docFlyIn = vrDoc !== prevVrDoc.current;
  useEffect(() => { prevVrDoc.current = vrDoc; });
  // Laser zoom inside focus mode. It SURVIVES page flips (you zoomed to read,
  // the next page should arrive at the same zoom) and resets when focus ends.
  const [zoomMul, setZoomMul] = useState(1);
  useEffect(() => { if (zoomKey === null) setZoomMul(1); }, [zoomKey]);
  const zoomMulProps = (key: string) => ({
    zoomMul: zoomKey === key ? zoomMul : 1,
    onZoomMul: (d: number) => setZoomMul((m) => Math.min(2.6, Math.max(0.6, m + d))),
  });
  // Pages grabbed out of the arc get pinned in world space.
  const movedPages = useRef(new Map<string, THREE.Vector3>());
  const [, bumpPages] = useState(0);
  // No AI description: just the page number, long doc names are noise.
  const vrTitle = (_n: FileNode, page: number, t?: string) =>
    !t || /manual page/i.test(t) ? `p.${page}` : t;
  // Scope ghosting works for BOTH drivers of the channel: the conversation
  // scope (panel open) and the user's category filter on the home universe.
  const scopeActive = scopeIds !== null && scopeIds.size < docs.length;
  const inScope = (docId: string) => !scopeActive || (scopeIds?.has(docId) ?? true);
  // Where a doc LIVES right now: scoped files migrate into a tight working
  // system around the core; ghosts stay out on the full shell.
  // Files NEVER relocate on their own: context recursion shows through light
  // only. The ONE exception is the user physically dragging a card in VR.
  const moved = useRef(new Map<string, THREE.Vector3>());
  const [, bumpMoved] = useState(0);
  const livePos = (n: FileNode) => moved.current.get(n.doc.id) ?? n.pos;
  const onMoved = (id: string, pos: THREE.Vector3, done: boolean) => {
    const v = moved.current.get(id) ?? new THREE.Vector3();
    v.copy(pos);
    moved.current.set(id, v);
    if (done) bumpMoved((k) => k + 1); // re-anchor bolts/pages once dropped
  };

  const { nodes, catAnchors } = useMemo(() => {
    const categories = [...new Set(docs.map((d) => d.category))].sort();
    // Fibonacci sphere: any number of categories spreads evenly over the shell
    // (band-limited so labels never sit at the poles).
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const anchors = categories.map((label, i) => {
      const n = Math.max(categories.length, 1);
      const y = n === 1 ? 0 : (1 - (i / (n - 1)) * 2) * 0.72; // clamp away from poles
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const a = i * GOLDEN;
      return { label, dir: new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad).normalize(), color: catColor(label) };
    });
    const out: FileNode[] = [];
    for (const doc of docs) {
      const ci = categories.indexOf(doc.category);
      const anchor = anchors[ci];
      const docsInCat = docs.filter((d) => d.category === doc.category);
      const di = docsInCat.indexOf(doc);
      const tangentA = new THREE.Vector3().crossVectors(anchor.dir, new THREE.Vector3(0, 1, 0)).normalize();
      const tangentB = new THREE.Vector3().crossVectors(anchor.dir, tangentA).normalize();
      const dir = anchor.dir.clone()
        .addScaledVector(tangentA, rnd(ci * 13 + di * 7) * 0.42 + (di % 2 === 0 ? 0.22 : -0.22))
        .addScaledVector(tangentB, rnd(ci * 29 + di * 11) * 0.42 + (di % 3 === 0 ? 0.12 : -0.08))
        .normalize();
      const sparkCount = Math.min(doc.pages.length, 48);
      out.push({
        doc,
        color: anchor.color,
        pos: dir.multiplyScalar(R),
        catIndex: ci,
        sparks: Array.from({ length: sparkCount }, (_, k) => [
          rnd(k * 3 + di) * 0.3, rnd(k * 5 + ci) * 0.3, rnd(k * 7 + di + ci) * 0.3,
        ]),
      });
    }
    return { nodes: out, catAnchors: anchors };
  }, [docs]);

  const hitByDoc = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const h of state.highlight) {
      if (!m.has(h.docId)) m.set(h.docId, []);
      m.get(h.docId)!.push(h.page);
    }
    return m;
  }, [state.highlight]);

  // Camera focus: the doc of the most recent hit - the agent's latest find.
  const focusNode = useMemo(() => {
    const last = state.highlight[state.highlight.length - 1];
    return last ? nodes.find((n) => n.doc.id === last.docId) ?? null : null;
  }, [state.highlight, nodes]);

  // Ambient camera drift is only for the idle home universe: on when nothing
  // is asking for attention, off the instant the agent points a doc (scan /
  // hit), a conversation opens, a doc is ingested or hovered, or the user
  // prefers reduced motion.
  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const idleSpin = !reduceMotion && !panelOpen && !hovering && !state.scanning
    && !state.ingesting && hitByDoc.size === 0 && focusNode === null;

  // VR: the doc the halo marks — the user's selection wins, then the agent's
  // latest find. The world NEVER rotates (pure field rotation = motion
  // discomfort); the arc brings the pages to the user instead.
  const turnFocusNode = vrDoc ? nodes.find((n) => n.doc.id === vrDoc) ?? null : focusNode;

  // Every page the agent pulled this step floats near its document, so the
  // universe visibly expands on each re-retrieve. Capped for legibility only.
  const MAX_FLOATING = 8;
  const floatingPages = useMemo(() => {
    const shown = state.highlight.slice(-MAX_FLOATING);
    const byDoc = new Map<string, number[]>();
    for (const h of shown) {
      if (!byDoc.has(h.docId)) byDoc.set(h.docId, []);
      byDoc.get(h.docId)!.push(h.page);
    }
    const out: { node: (typeof nodes)[number]; page: number; url: string; label?: string; title?: string; index: number; total: number }[] = [];
    for (const [docId, pages] of byDoc) {
      const node = nodes.find((n) => n.doc.id === docId);
      if (!node) continue;
      pages.forEach((page, index) => {
        const pg = node.doc.pages.find((p) => p.page === page);
        const ts = pg?.timestamp;
        const label = ts !== undefined ? `${Math.floor(ts / 60)}:${String(ts % 60).padStart(2, '0')}` : undefined;
        out.push({ node, page, url: pg?.imageUrl ?? '', label, title: pg ? pageTitle(pg) : undefined, index, total: pages.length });
      });
    }
    return out.filter((p) => p.url);
  }, [state.highlight, nodes]);

  // VR evidence arc: the selected doc's pages, or the agent's latest
  // retrievals, whichever is most recent. Capped at the 6 arc slots.
  const vrPages = useMemo(() => {
    if (!vr) return [];
    if (vrDoc) {
      const node = nodes.find((n) => n.doc.id === vrDoc);
      if (node) {
        return node.doc.pages.slice(fanOffset, fanOffset + 6).map((pg) => {
          const ts = pg.timestamp;
          return {
            key: `sel-${node.doc.id}-${pg.page}`,
            url: pg.imageUrl ?? '',
            label: ts !== undefined ? `${Math.floor(ts / 60)}:${String(ts % 60).padStart(2, '0')}` : undefined,
            title: pageTitle(pg),
            node,
            page: pg.page,
          };
        }).filter((p) => p.url);
      }
    }
    return floatingPages.slice(-6).map((p) => ({
      key: `${p.node.doc.id}-${p.page}`,
      url: p.url, label: p.label, title: p.title, node: p.node, page: p.page,
    }));
  }, [vr, vrDoc, nodes, floatingPages, fanOffset]);

  // Reset the aim count whenever the arc's content changes: an aimed page
  // that unmounts never fires pointer-out, and a leaked count would freeze
  // the evidence arc far away forever. Focus survives window paging (its key
  // is still present); it dies when the content is truly replaced.
  useEffect(() => {
    setArcAim(0);
    setZoomKey((k) => (k && vrPages.some((p) => p.key === k) ? k : null));
  }, [vrPages]);
  // Entering focus unmounts the sibling pages; one aimed by the OTHER
  // controller ray never fires pointer-out and would freeze the arc forever.
  useEffect(() => { if (zoomKey === null) setArcAim(0); }, [zoomKey]);
  // Warm the neighbors of the focused page so < > flips are instant.
  useEffect(() => {
    if (!zoomKey) return;
    const cur = vrPages.find((p) => p.key === zoomKey);
    if (!cur) return;
    const pages = cur.node.doc.pages;
    const idx = pages.findIndex((pg) => pg.page === cur.page);
    for (const j of [idx - 1, idx + 1, idx + 2]) prefetchTexture(pages[j]?.imageUrl);
  }, [zoomKey, vrPages]);
  const zoomToggle = (key: string) => () => setZoomKey((k) => (k === key ? null : key));
  // Focus-nav inside a doc: flips through ALL its pages, sliding the window.
  const fanNav = (docNode: FileNode, page: number) => (dir: 1 | -1) => {
    const pages = docNode.doc.pages;
    const idx = pages.findIndex((pg) => pg.page === page);
    const t = Math.min(pages.length - 1, Math.max(0, idx + dir));
    if (t === idx) return;
    setFanOffset(Math.floor(t / 6) * 6);
    setZoomKey(`sel-${docNode.doc.id}-${pages[t].page}`);
  };
  // Nav from a PINNED page: opens its doc (if not already) and focuses the
  // target page in the arc, window aligned.
  const pinNav = (docNode: FileNode, page: number) => (dir: 1 | -1) => {
    const pages = docNode.doc.pages;
    const idx = pages.findIndex((pg) => pg.page === page);
    const t = Math.min(pages.length - 1, Math.max(0, idx + dir));
    if (t === idx) return;
    setVrDoc(docNode.doc.id);
    setFanOffset(Math.floor(t / 6) * 6);
    setZoomKey(`sel-${docNode.doc.id}-${pages[t].page}`);
  };

  return (
    <>
      <color attach="background" args={['#070a0f']} />
      <ambientLight intensity={0.3} />
      <DeepSpace />
      {/* Decorative orbit ellipses only make sense seen from outside; from
          inside (VR) they degenerate into a bright edge-on line. */}
      <IfInSessionMode deny={['immersive-vr', 'immersive-ar']}>
        <OrbitRings />
      </IfInSessionMode>

      {/* VR focus mode: the WHOLE universe vanishes while a page is read.
          A world-anchored veil can never survive 6DOF (move or turn and you
          see past it, and siblings sort through it); hiding the world is the
          only bulletproof theater mode. Desktop never hides (no zoomKey). */}
      <group visible={!(vr && zoomKey !== null)}>
      <AgentCore scanning={state.scanning} />
      {catAnchors.map((c) => {
        const catInScope = nodes.some((n) => n.doc.category === c.label && inScope(n.doc.id));
        return (
          <Billboard key={c.label} position={c.dir.clone().multiplyScalar(R + 0.5).toArray()}>
            <Text font={displayFont} fontSize={vr ? 0.19 : 0.082} color={c.color} anchorX="center" letterSpacing={0.22} outlineWidth={0.005} outlineColor="#080b10" fillOpacity={catInScope ? (vr ? 0.85 : 0.68) : (vr ? 0.14 : 0.08)}>
              {c.label.toUpperCase()}
            </Text>
          </Billboard>
        );
      })}

      {nodes.map((n) => (
        <group key={n.doc.id}>
          {hitByDoc.has(n.doc.id) && <LightningBolt to={livePos(n)} color={n.color} />}
          <FileCard
            node={n}
            targetPos={livePos(n)}
            ghost={!inScope(n.doc.id)}
            bornAtCore={state.lastBorn === n.doc.id}
            isHit={hitByDoc.has(n.doc.id)}
            hitCount={(hitByDoc.get(n.doc.id) ?? []).length}
            onHover={onHover}
            onSelect={(id) => { if (vr) { setFanOffset(0); setVrDoc((cur) => (cur === id ? null : id)); } else onSelect(id); }}
            sizeMul={vr ? 1.8 : 1}
            vr={vr}
            onMoved={vr ? onMoved : undefined}
            disabled={vr && zoomKey !== null}
          />
        </group>
      ))}

      {state.scanning && (
        <ScanStorm targets={nodes.filter((n) => inScope(n.doc.id) && !hitByDoc.has(n.doc.id)).map((n) => ({ pos: livePos(n), color: n.color }))} />
      )}

      {state.ingesting && (
        <group>
          <IngestEmbryo />
          <LightningBolt to={EMBRYO_POS} color="#ffd9a0" interval={0.05} />
        </group>
      )}

      {!vr && floatingPages.map((p) => (
        <FloatingPage
          key={`${p.node.doc.id}-${p.page}`}
          url={p.url}
          label={p.label}
          title={p.title}
          index={p.index}
          total={p.total}
          anchor={livePos(p.node)}
          color={p.node.color}
          onClick={() => onOpenPage(p.node.doc.id, p.page)}
        />
      ))}
      {vr && turnFocusNode && <FocusRing pos={livePos(turnFocusNode)} color={turnFocusNode.color} />}
      </group>

      {/* VR: ALL pages come to you in the arc — the agent's evidence AND the
          doc you open yourself. The world never moves; each page flies out of
          its source planet into a slot, and a tether points back home.
          Grabbed pages leave the arc and pin in the world. */}
      {vr && (
        <VRArc frozen={arcAim > 0 || zoomKey !== null}>
          {/* Focus mode shows ONLY the zoomed page: sibling pages sit at the
              same depth as the veil and the transparent sort (per-origin
              view-z) draws them through it. One page, no ambiguity. The map
              stays complete so each page keeps its slot index. */}
          {vrPages.filter((p) => !movedPages.current.has(p.key)).map((p, i) => (zoomKey !== null && zoomKey !== p.key) ? null : (
            <FloatingPage
              key={p.key}
              url={p.url}
              label={p.label}
              title={vrTitle(p.node, p.page, p.title)}
              index={i}
              total={vrPages.length}
              anchor={livePos(p.node)}
              color={p.node.color}
              overrideTarget={vrArcLocal(i)}
              spawnWorld={!vrDoc || docFlyIn ? livePos(p.node) : undefined}
              scaleMul={1.18}
              zoomed={zoomKey === p.key}
              docChip={{
                label: `${p.node.doc.brand} ${p.node.doc.model.split('(')[0].trim()}`,
                color: p.node.color,
                coverUrl: p.node.doc.pages[0]?.imageUrl,
                onGo: () => setZoomKey(null),
              }}
              onAimChange={(over) => setArcAim((n) => Math.max(0, n + (over ? 1 : -1)))}
              onPinned={(wp) => { movedPages.current.set(p.key, wp.clone()); setArcAim(0); bumpPages((k) => k + 1); }}
              onClick={zoomToggle(p.key)}
              onNav={vrDoc ? fanNav(p.node, p.page) : (dir) => {
                const list = vrPages.filter((q) => !movedPages.current.has(q.key));
                const idx = list.findIndex((q) => q.key === p.key);
                const t = Math.min(list.length - 1, Math.max(0, idx + dir));
                if (t !== idx) setZoomKey(list[t].key);
              }}
              navLabel={vrDoc
                ? `${p.node.doc.pages.findIndex((pg) => pg.page === p.page) + 1} / ${p.node.doc.pages.length}`
                : `${i + 1} / ${vrPages.length}`}
              {...zoomMulProps(p.key)}
            />
          ))}
          {/* Opened-doc chrome: title + window counter up top, close pill,
              paging pills at the sides — all in rig space, near the hands.
              Hidden in focus mode: nothing competes with the page. */}
          {vrDoc && zoomKey === null && (() => {
            const node = nodes.find((n) => n.doc.id === vrDoc);
            if (!node) return null;
            const total = node.doc.pages.length;
            const docLabel = `${node.doc.brand} ${node.doc.model.split('(')[0].trim()}`;
            // The FILE docked top center, above its page grid, flanked by the
            // window pills. The grid sits between the user and the planet, so
            // the doc lives in the rig: always visible, always clickable
            // (click = close). Its texts sit above the cover so nothing
            // collides with the grid's top row.
            return (
              <group>
                <DocTether target={livePos(node)} color={node.color} />
                {fanOffset > 0 && (
                  <VRNavPill position={[-0.68, 0.95, 1.2]} label="<" r={0.09} onGo={() => setFanOffset((o) => Math.max(0, o - 6))} />
                )}
                {fanOffset + 6 < total && (
                  <VRNavPill position={[0.68, 0.95, 1.2]} label=">" r={0.09} onGo={() => setFanOffset((o) => o + 6)} />
                )}
                <Billboard position={[0, 1.07, 1.15]}>
                  <group scale={1.15}>
                    <DocChip
                      file
                      sub={total > 6 ? `${fanOffset + 1}-${Math.min(fanOffset + 6, total)}/${total}` : `${total} P`}
                      chip={{
                        label: ell(docLabel, 20).toUpperCase(),
                        color: node.color,
                        coverUrl: node.doc.pages[0]?.imageUrl,
                        onGo: () => setVrDoc(null),
                      }}
                      x={0}
                    />
                  </group>
                </Billboard>
              </group>
            );
          })()}
        </VRArc>
      )}
      {vr && vrPages.filter((p) => movedPages.current.has(p.key) && (zoomKey === null || zoomKey === p.key)).map((p) => (
        <FloatingPage
          key={`pin-${p.key}`}
          url={p.url}
          label={p.label}
          title={vrTitle(p.node, p.page, p.title)}
          index={0}
          total={1}
          anchor={livePos(p.node)}
          color={p.node.color}
          overrideTarget={movedPages.current.get(p.key)!}
          scaleMul={1.18}
          pinned
          zoomed={zoomKey === p.key}
          docChip={{
            label: `${p.node.doc.brand} ${p.node.doc.model.split('(')[0].trim()}`,
            color: p.node.color,
            coverUrl: p.node.doc.pages[0]?.imageUrl,
            onGo: () => setZoomKey(null),
          }}
          onPinned={(wp) => { movedPages.current.set(p.key, wp.clone()); bumpPages((k) => k + 1); }}
          onClick={zoomToggle(p.key)}
          onNav={pinNav(p.node, p.page)}
          navLabel={`${p.node.doc.pages.findIndex((pg) => pg.page === p.page) + 1} / ${p.node.doc.pages.length}`}
          {...zoomMulProps(p.key)}
        />
      ))}


      {/* Desktop: the agent drives the eye. In an immersive session the
          headset owns the camera, so the rig must not fight it. */}
      <IfInSessionMode deny={['immersive-vr', 'immersive-ar']}>
        <CameraRig focus={focusNode ? livePos(focusNode) : null} panelOpen={panelOpen} idle={idleSpin} />
      </IfInSessionMode>
      {/* VR: the user stands INSIDE the planet of files, eye level just
          above the plasma core, one step back. */}
      <IfInSessionMode allow="immersive-vr">
        <VRLocomotion />
        <VRMessageBar draft={vrDraft} onKeyboard={onVrKeyboard} onSend={onVrSend} />
        <VRAmbiance />
      </IfInSessionMode>
    </>
  );
}

export function Galaxy3D({ panelOpen = false, scopeIds = null, onSelectDoc, onOpenPage }: {
  panelOpen?: boolean;
  scopeIds?: Set<string> | null;
  onSelectDoc?: (docId: string) => void;
  onOpenPage?: (docId: string, page: number) => void;
}) {
  const { state, dispatch } = useApp();
  const [hover, setHover] = useState<{ doc: Document; x: number; y: number } | null>(null);
  const [vrReady, setVrReady] = useState(false);
  const [vrDraft, setVrDraft] = useState('');
  const vrInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The localhost emulator injects navigator.xr ASYNCHRONOUSLY, so a single
    // mount-time check can lose the race and hide the button forever: retry.
    let alive = true;
    let tries = 0;
    const check = async () => {
      const ok = await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false);
      if (!alive) return;
      if (ok) setVrReady(true);
      else if (++tries < 24) setTimeout(check, 500);
    };
    void check();
    return () => { alive = false; };
  }, []);

  // VR bar submit: active conversation gets it via the store outbox, no
  // conversation yet means the text opens one (same parse as the CommandBar).
  const vrSend = () => {
    const text = vrDraft.trim();
    if (!text) return;
    if (state.activeView.kind === 'conversation') {
      dispatch({ type: 'vr-outbox', text });
    } else {
      const m = text.match(/^(.{3,60}?)\s*(?:—|--|:)\s*(.+)$/);
      dispatch({
        type: 'new-conversation',
        id: crypto.randomUUID(),
        device: m ? m[1].trim() : text,
        symptom: m ? m[2].trim() : 'as described by the technician',
        attachments: [],
      });
    }
    setVrDraft('');
  };

  return (
    <div className="galaxy-wrap">
      <Canvas camera={{ position: [0, 2.6, 10.2], fov: 42 }} dpr={[1, 2]}>
        <XR store={xrStore}>
          <Scene
            panelOpen={panelOpen}
            scopeIds={scopeIds}
            hovering={hover !== null}
            onHover={setHover}
            onSelect={(id) => onSelectDoc?.(id)}
            onOpenPage={(d, p) => onOpenPage?.(d, p)}
            vrDraft={vrDraft}
            onVrKeyboard={() => vrInputRef.current?.focus()}
            onVrSend={vrSend}
          />
        </XR>
      </Canvas>
      {/* Real DOM input behind the VR bar: focusing it pops the Quest system
          keyboard in-session; on desktop the physical keyboard types here. */}
      <input
        ref={vrInputRef}
        className="galaxy-vr-hidden-input"
        value={vrDraft}
        onChange={(e) => setVrDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') vrSend(); }}
        tabIndex={-1}
        aria-label="VR message to the agent"
      />
      {vrReady && (
        <button className="galaxy-vr-btn btn" onClick={() => xrStore.enterVR()}>
          Enter VR
        </button>
      )}
      {hover && (
        <div className="galaxy-card" style={{ left: hover.x + 14, top: hover.y + 10 }}>
          <div className="galaxy-card-title">{hover.doc.brand} {hover.doc.model}</div>
          <div className="galaxy-card-line mono">
            {hover.doc.docType} · {hover.doc.pages.length} pages · {hover.doc.format.toUpperCase()}
          </div>
          <div className="galaxy-card-rights">{hover.doc.sourceRights}</div>
        </div>
      )}
    </div>
  );
}
