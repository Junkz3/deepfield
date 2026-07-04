// THE PLANET OF FILES — permanent stage of the app.
// One holographic body of document-cards around the agent core. The scene is
// still by design; the USER navigates, and the AGENT animates it: retrieval
// flies the camera to the touched file, real manual pages fan out in space,
// beams link the evidence back to the core.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, Line, OrbitControls, Text } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Document } from '../../agent/types';
import { pageTitle } from '../../agent/taxonomy';
import { useApp } from '../store';
import displayFont from '@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff?url';

const R = 2.75; // shell radius of the file planet

const CAT_COLORS: Record<string, string> = {
  'dishwasher': '#59c2ff',
  'washing machine': '#6e9cff',
  'vehicle': '#a3d977',
  'smartphone': '#c792ea',
  'game console': '#f07178',
  'coffee machine': '#e6b455',
};
/** Fixed hues for the core categories; deterministic generated hues for the rest. */
const catColor = (label: string) => {
  const key = label.toLowerCase();
  if (CAT_COLORS[key]) return CAT_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, ${62 + (h % 3) * 8}%, ${64 + (h % 4) * 4}%)`;
};

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

function makeBoltLine(color: string, opacity: number): THREE.Line {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((BOLT_PTS + 1) * 3), 3));
  const mat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  return line;
}

/** One crackling bolt from the core to a target. Three superimposed jittered
 *  passes (white core, colored sheath, wide halo) regenerate ~14x/s. */
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
    const spread = [0.035, 0.06, 0.1];
    lines.forEach((line, li) => {
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= BOLT_PTS; i++) {
        const t = i / BOLT_PTS;
        const env = Math.sin(t * Math.PI) * len * spread[li];
        const a = (Math.random() - 0.5) * 2 * env;
        const b = (Math.random() - 0.5) * 2 * env;
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

/** While the agent scans, 4-5 bolts probe random in-scope files, retargeting
 *  fast — the plasma globe reaching for fingers. */
function ScanStorm({ targets }: { targets: { pos: THREE.Vector3; color: string }[] }) {
  const SLOTS = Math.min(5, Math.max(2, targets.length));
  const [picks, setPicks] = useState<number[]>([]);
  const swapAt = useRef<number[]>([]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    let changed = false;
    const next = [...picks];
    for (let sIdx = 0; sIdx < SLOTS; sIdx++) {
      if (swapAt.current[sIdx] === undefined || t >= swapAt.current[sIdx]) {
        next[sIdx] = Math.floor(Math.random() * targets.length);
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
  const pulse = useRef<THREE.Mesh>(null);
  const gyroA = useRef<THREE.Group>(null);
  const gyroB = useRef<THREE.Group>(null);
  const gyroC = useRef<THREE.Group>(null);
  const orbiters = useRef<THREE.Points>(null);
  const haloMap = useMemo(() => radialSprite('255, 178, 92'), []);

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
    if (halo.current) halo.current.scale.setScalar(1.35 + Math.sin(t * 1.1) * 0.07);
    // gyroscope: three thin rings precessing on different axes
    if (gyroA.current) { gyroA.current.rotation.x = t * 0.42; gyroA.current.rotation.y = t * 0.18; }
    if (gyroB.current) { gyroB.current.rotation.y = -t * 0.31; gyroB.current.rotation.z = t * 0.22; }
    if (gyroC.current) { gyroC.current.rotation.z = t * 0.15; gyroC.current.rotation.x = -t * 0.26; }
    if (orbiters.current) orbiters.current.rotation.y = t * 0.5;
    if (pulse.current) {
      const phase = (t % 1.3) / 1.3;
      pulse.current.visible = scanning;
      if (scanning) {
        pulse.current.scale.setScalar(0.3 + phase * R * 1.05);
        (pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - phase);
      }
    }
  });

  return (
    <group>
      {/* white-hot nucleus in a warm shell */}
      <mesh>
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

      <mesh ref={pulse} rotation={[Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[1, 0.016, 8, 64]} />
        <meshBasicMaterial color="#ffb454" transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
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

function FileCard({ node, targetPos, ghost, bornAtCore, isHit, hitCount, onHover, onSelect }: {
  node: FileNode;
  targetPos: THREE.Vector3;
  ghost: boolean;
  bornAtCore: boolean;
  isHit: boolean;
  hitCount: number;
  onHover: (h: { doc: Document; x: number; y: number } | null) => void;
  onSelect: (docId: string) => void;
}) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const root = useRef<THREE.Group>(null);
  const seed = node.doc.id.length + node.catIndex * 7;

  useFrame(({ clock }, dt) => {
    // Contextual recursion: the universe recomposes — scoped files migrate
    // toward the core, everything else fades to a distant ghost.
    if (root.current) root.current.position.lerp(targetPos, Math.min(dt * 2.6, 1));
    if (!mat.current) return;
    const t = clock.elapsedTime;
    const hasCover = !!cover;
    const base = ghost ? (hasCover ? 0.08 : 0.06) : isHit ? 1 : hasCover ? 0.95 : 0.68;
    const flicker = ghost || hasCover ? 0 : Math.sin(t * (1.6 + (seed % 3) * 0.5) + seed) * 0.1;
    mat.current.opacity = base + flicker;
  });

  // Real face of the document: its first page (or the video thumbnail).
  const coverUrl = node.doc.pages[0]?.imageUrl || '';
  const [cover, setCover] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!coverUrl) { setCover(null); return; }
    let alive = true;
    new THREE.TextureLoader().load(coverUrl, (t) => {
      if (alive) { t.colorSpace = THREE.SRGBColorSpace; setCover(t); }
    }, undefined, () => { if (alive) setCover(null); });
    return () => { alive = false; };
  }, [coverUrl]);

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
        <mesh
          key={cover ? 'cover' : 'holo'}
          onPointerOver={(e) => { if (ghost) return; e.stopPropagation(); onHover({ doc: node.doc, x: e.clientX ?? 0, y: e.clientY ?? 0 }); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { if (ghost) return; onHover(null); document.body.style.cursor = ''; }}
          onClick={(e) => { if (ghost) return; e.stopPropagation(); onSelect(node.doc.id); }}
        >
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

function FloatingPage({ url, label, title, index, total, anchor, color, onClick }: {
  url: string; label?: string; title?: string; index: number; total: number; anchor: THREE.Vector3; color: string; onClick: () => void;
}) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const group = useRef<THREE.Group>(null);
  const born = useRef(0);
  // mm:ss label only exists on video segments: frames are 16:9, pages portrait
  const video = !!label;
  const W = video ? 0.82 : 0.54;
  const H = video ? 0.46 : 0.72;

  useEffect(() => {
    let alive = true;
    new THREE.TextureLoader().load(url, (t) => {
      if (alive) { t.colorSpace = THREE.SRGBColorSpace; setTex(t); }
    });
    return () => { alive = false; };
  }, [url]);

  const target = useMemo(() => {
    const up = anchor.clone().normalize();
    const side = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).normalize();
    const gap = total > 4 ? 0.46 : 0.56; // tighten the fan when the agent pulled many pages
    const spread = (index - (total - 1) / 2) * gap;
    return anchor.clone()
      .addScaledVector(up, 0.75 + Math.abs(spread) * 0.08)
      .addScaledVector(side, spread);
  }, [anchor, index, total]);

  useFrame(({ clock }, dt) => {
    if (!group.current) return;
    if (born.current === 0) born.current = clock.elapsedTime;
    const age = clock.elapsedTime - born.current;
    const k = Math.min(age / 0.55, 1);
    const ease = 1 - Math.pow(1 - k, 3);
    if (k < 1) {
      group.current.position.lerpVectors(anchor, target, ease);
    } else {
      // target moves when later retrieves widen the fan: glide, don't snap
      group.current.position.lerp(target, Math.min(dt * 4, 1));
    }
    group.current.position.y += Math.sin(clock.elapsedTime * 1.4 + index * 2) * 0.02;
    group.current.scale.setScalar(0.25 + ease * 0.75);
  });

  if (!tex) return null;
  return (
    <group ref={group} position={anchor}>
      <Billboard>
        <mesh position={[0, 0, -0.004]}>
          <planeGeometry args={[W + 0.02, H + 0.02]} />
          <meshBasicMaterial color={video ? '#ffb454' : color} transparent opacity={video ? 0.7 : 0.55} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
        <mesh onClick={(e) => { e.stopPropagation(); onClick(); }}>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial map={tex} toneMapped={false} />
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
      </Billboard>
    </group>
  );
}

/* ---------- camera: the agent drives the eye ---------- */

function CameraRig({ focus, panelOpen }: { focus: THREE.Vector3 | null; panelOpen: boolean }) {
  const { camera } = useThree();
  const controls = useRef<any>(null);

  useFrame((_, dt) => {
    if (!controls.current) return;
    const c = controls.current;
    const lookTarget = focus ? focus.clone().multiplyScalar(0.82) : new THREE.Vector3(0, 0, 0);
    if (panelOpen) {
      // Chat panel covers the left half: shift the look target left in camera
      // space so the planet re-centers in the right half of the screen.
      const right = new THREE.Vector3().subVectors(c.target, camera.position).cross(camera.up).normalize();
      lookTarget.addScaledVector(right, -1.15);
    }
    c.target.lerp(lookTarget, Math.min(dt * 2.4, 1));

    const wantDist = focus ? 6.2 : 10.2;
    const dir = new THREE.Vector3().subVectors(camera.position, c.target);
    const newDist = THREE.MathUtils.lerp(dir.length(), wantDist, Math.min(dt * 1.6, 1));
    camera.position.copy(c.target.clone().addScaledVector(dir.normalize(), newDist));
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      minDistance={5}
      maxDistance={18}
      maxPolarAngle={Math.PI * 0.72}
      minPolarAngle={Math.PI * 0.18}
    />
  );
}

/* ---------- scene ---------- */

function Scene({ panelOpen, scopeIds, onHover, onSelect, onOpenPage }: {
  panelOpen: boolean;
  scopeIds: Set<string> | null;
  onHover: (h: { doc: Document; x: number; y: number } | null) => void;
  onSelect: (docId: string) => void;
  onOpenPage: (docId: string, page: number) => void;
}) {
  const { state, docs } = useApp();
  const scopeActive = panelOpen && scopeIds !== null && scopeIds.size < docs.length;
  const inScope = (docId: string) => !scopeActive || (scopeIds?.has(docId) ?? true);
  // Where a doc LIVES right now: scoped files migrate into a tight working
  // system around the core; ghosts stay out on the full shell.
  const livePos = (n: FileNode) => (scopeActive && inScope(n.doc.id) ? n.pos.clone().multiplyScalar(0.5) : n.pos);

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

  return (
    <>
      <color attach="background" args={['#070a0f']} />
      <ambientLight intensity={0.3} />
      <DeepSpace />
      <OrbitRings />
      <AgentCore scanning={state.scanning} />

      {catAnchors.map((c) => {
        const catInScope = nodes.some((n) => n.doc.category === c.label && inScope(n.doc.id));
        return (
          <Billboard key={c.label} position={c.dir.clone().multiplyScalar(R + 0.5).toArray()}>
            <Text font={displayFont} fontSize={0.082} color={c.color} anchorX="center" letterSpacing={0.22} outlineWidth={0.005} outlineColor="#080b10" fillOpacity={catInScope ? 0.68 : 0.08}>
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
            onSelect={onSelect}
          />
        </group>
      ))}

      {state.scanning && (
        <ScanStorm targets={nodes.filter((n) => inScope(n.doc.id)).map((n) => ({ pos: livePos(n), color: n.color }))} />
      )}

      {state.ingesting && (
        <group>
          <IngestEmbryo />
          <LightningBolt to={EMBRYO_POS} color="#ffd9a0" interval={0.05} />
          <LightningBolt to={EMBRYO_POS} color="#59c2ff" interval={0.09} />
        </group>
      )}

      {floatingPages.map((p) => (
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

      <CameraRig focus={focusNode ? livePos(focusNode) : null} panelOpen={panelOpen} />
    </>
  );
}

export function Galaxy3D({ panelOpen = false, scopeIds = null, onSelectDoc, onOpenPage }: {
  panelOpen?: boolean;
  scopeIds?: Set<string> | null;
  onSelectDoc?: (docId: string) => void;
  onOpenPage?: (docId: string, page: number) => void;
}) {
  const [hover, setHover] = useState<{ doc: Document; x: number; y: number } | null>(null);
  return (
    <div className="galaxy-wrap">
      <Canvas camera={{ position: [0, 2.6, 10.2], fov: 42 }} dpr={[1, 2]}>
        <Scene
          panelOpen={panelOpen}
          scopeIds={scopeIds}
          onHover={setHover}
          onSelect={(id) => onSelectDoc?.(id)}
          onOpenPage={(d, p) => onOpenPage?.(d, p)}
        />
      </Canvas>
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
