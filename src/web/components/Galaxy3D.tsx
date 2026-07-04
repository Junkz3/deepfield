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
import { useApp } from '../store';

const R = 1.9; // shell radius of the file planet

const CAT_COLORS: Record<string, string> = {
  'dishwasher': '#59c2ff',
  'washing machine': '#6e9cff',
  'vehicle': '#a3d977',
  'smartphone': '#c792ea',
  'game console': '#f07178',
  'coffee machine': '#e6b455',
};
const catColor = (label: string) => CAT_COLORS[label.toLowerCase()] ?? '#8b99a8';

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

/* ---------- the agent core ---------- */

function AgentCore({ scanning }: { scanning: boolean }) {
  const halo = useRef<THREE.Sprite>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const haloMap = useMemo(() => radialSprite('255, 178, 92'), []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (halo.current) halo.current.scale.setScalar(1.9 + Math.sin(t * 1.1) * 0.12);
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
      <mesh>
        <sphereGeometry args={[0.26, 32, 32]} />
        <meshBasicMaterial color="#ffc678" />
      </mesh>
      <sprite ref={halo} scale={[1.9, 1.9, 1]}>
        <spriteMaterial map={haloMap} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <mesh ref={pulse} rotation={[Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[1, 0.016, 8, 64]} />
        <meshBasicMaterial color="#ffb454" transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight intensity={40} distance={26} color="#ffd9a0" />
      <Billboard position={[0, -0.62, 0]}>
        <Text fontSize={0.11} color="#c8964f" letterSpacing={0.34} anchorX="center" outlineWidth={0.004} outlineColor="#080b10">
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

function FileCard({ node, targetPos, ghost, isHit, hitCount, onHover, onSelect }: {
  node: FileNode;
  targetPos: THREE.Vector3;
  ghost: boolean;
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
    const base = ghost ? 0.06 : isHit ? 1 : 0.68;
    const flicker = ghost ? 0 : Math.sin(t * (1.6 + (seed % 3) * 0.5) + seed) * 0.1;
    mat.current.opacity = base + flicker;
  });

  const texture = fileCardTexture(node.color);
  const scale: [number, number] = isHit ? [0.42, 0.525] : [0.3, 0.375];

  return (
    <group ref={root} position={node.pos}>
      <Billboard>
        <mesh
          onPointerOver={(e) => { if (ghost) return; e.stopPropagation(); onHover({ doc: node.doc, x: e.clientX ?? 0, y: e.clientY ?? 0 }); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { if (ghost) return; onHover(null); document.body.style.cursor = ''; }}
          onClick={(e) => { if (ghost) return; e.stopPropagation(); onSelect(node.doc.id); }}
        >
          <planeGeometry args={scale} />
          <meshBasicMaterial
            ref={mat}
            map={texture}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            color={isHit ? '#ffffff' : node.color}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
        {node.doc.origin === 'session' && (
          <mesh position={[0, 0, -0.01]}>
            <ringGeometry args={[0.3, 0.315, 32]} />
            <meshBasicMaterial color="#ffb454" transparent opacity={0.85} depthWrite={false} />
          </mesh>
        )}
        {!ghost && (
          <Text
            position={[0, -0.31, 0]}
            fontSize={0.095}
            color={isHit ? '#ffffff' : '#93a3b3'}
            anchorX="center"
            outlineWidth={0.005}
            outlineColor="#080b10"
          >
            {node.doc.model}
          </Text>
        )}
        {isHit && hitCount > 0 && (
          <Text position={[0, 0.35, 0]} fontSize={0.085} color="#ffc678" anchorX="center" outlineWidth={0.005} outlineColor="#080b10">
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

function FloatingPage({ url, index, total, anchor, color, onClick }: {
  url: string; index: number; total: number; anchor: THREE.Vector3; color: string; onClick: () => void;
}) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const group = useRef<THREE.Group>(null);
  const born = useRef(0);

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
    const spread = (index - (total - 1) / 2) * 0.56;
    return anchor.clone()
      .addScaledVector(up, 0.75 + Math.abs(spread) * 0.08)
      .addScaledVector(side, spread);
  }, [anchor, index, total]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    if (born.current === 0) born.current = clock.elapsedTime;
    const age = clock.elapsedTime - born.current;
    const k = Math.min(age / 0.55, 1);
    const ease = 1 - Math.pow(1 - k, 3);
    group.current.position.lerpVectors(anchor, target, ease);
    group.current.position.y += Math.sin(clock.elapsedTime * 1.4 + index * 2) * 0.02;
    group.current.scale.setScalar(0.25 + ease * 0.75);
  });

  if (!tex) return null;
  return (
    <group ref={group} position={anchor}>
      <Billboard>
        <mesh position={[0, 0, -0.004]}>
          <planeGeometry args={[0.56, 0.74]} />
          <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
        <mesh onClick={(e) => { e.stopPropagation(); onClick(); }}>
          <planeGeometry args={[0.54, 0.72]} />
          <meshBasicMaterial map={tex} toneMapped={false} />
        </mesh>
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

    const wantDist = focus ? 5.4 : 7.4;
    const dir = new THREE.Vector3().subVectors(camera.position, c.target);
    const newDist = THREE.MathUtils.lerp(dir.length(), wantDist, Math.min(dt * 1.6, 1));
    camera.position.copy(c.target.clone().addScaledVector(dir.normalize(), newDist));
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      minDistance={3.4}
      maxDistance={13}
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
    const anchors = categories.map((label, i) => {
      const a = (i / Math.max(categories.length, 1)) * Math.PI * 2;
      const y = 0.34 * (i % 2 === 0 ? 1 : -1);
      return { label, dir: new THREE.Vector3(Math.cos(a), y, Math.sin(a)).normalize(), color: catColor(label) };
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
        .addScaledVector(tangentA, rnd(ci * 13 + di * 7) * 0.34 + (di % 2 === 0 ? 0.14 : -0.14))
        .addScaledVector(tangentB, rnd(ci * 29 + di * 11) * 0.3)
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

  // The file the agent is reading right now: camera focus + floating pages.
  const focusNode = useMemo(() => {
    const first = state.highlight[0];
    return first ? nodes.find((n) => n.doc.id === first.docId) ?? null : null;
  }, [state.highlight, nodes]);

  const floatingPages = useMemo(() => {
    if (!focusNode) return [];
    const pages = hitByDoc.get(focusNode.doc.id) ?? [];
    return pages.slice(0, 3)
      .map((page) => ({ page, url: focusNode.doc.pages.find((p) => p.page === page)?.imageUrl ?? '' }))
      .filter((p) => p.url);
  }, [focusNode, hitByDoc]);

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
          <Billboard key={c.label} position={c.dir.clone().multiplyScalar(R + 0.72).toArray()}>
            <Text fontSize={0.082} color={c.color} anchorX="center" letterSpacing={0.22} outlineWidth={0.005} outlineColor="#080b10" fillOpacity={catInScope ? 0.8 : 0.1}>
              {c.label.toUpperCase()}
            </Text>
          </Billboard>
        );
      })}

      {nodes.map((n) => (
        <group key={n.doc.id}>
          {hitByDoc.has(n.doc.id) && (
            <Line
              points={[[0, 0, 0], livePos(n).toArray()]}
              color={n.color}
              lineWidth={2.5}
              dashed
              dashScale={6}
              transparent
              opacity={0.9}
            />
          )}
          <FileCard
            node={n}
            targetPos={livePos(n)}
            ghost={!inScope(n.doc.id)}
            isHit={hitByDoc.has(n.doc.id)}
            hitCount={(hitByDoc.get(n.doc.id) ?? []).length}
            onHover={onHover}
            onSelect={onSelect}
          />
        </group>
      ))}

      {focusNode && floatingPages.map((p, i) => (
        <FloatingPage
          key={`${focusNode.doc.id}-${p.page}`}
          url={p.url}
          index={i}
          total={floatingPages.length}
          anchor={livePos(focusNode)}
          color={focusNode.color}
          onClick={() => onOpenPage(focusNode.doc.id, p.page)}
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
      <Canvas camera={{ position: [0, 2.0, 7.4], fov: 42 }} dpr={[1, 2]}>
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
