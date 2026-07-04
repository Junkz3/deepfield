// THE PLANET OF FILES. One celestial body made of holographic document cards
// swarming on a spherical shell around the agent core. Categories are regions
// of the shell; every document is a glowing file-card; its pages are the dust
// cloud around it. Retrieval fires light beams from the core to the exact
// files it touched: the agent literally reaches into its knowledge.
import { Canvas, useFrame } from '@react-three/fiber';
import { Billboard, Line, OrbitControls, Stars, Text } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
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

/** Deterministic pseudo-random in [-1,1] from a seed — stable swarm shapes. */
const rnd = (seed: number) => Math.sin(seed * 127.1 + 311.7) * 0.5 + Math.sin(seed * 74.7) * 0.5;

/** Holographic file-card texture, tinted per category (cached). */
const cardTextureCache = new Map<string, THREE.CanvasTexture>();
function fileCardTexture(color: string): THREE.CanvasTexture {
  const hit = cardTextureCache.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 160;
  const g = c.getContext('2d')!;
  const fold = 30;
  g.clearRect(0, 0, 128, 160);
  // card body with folded corner
  g.beginPath();
  g.moveTo(10, 6);
  g.lineTo(128 - fold - 10, 6);
  g.lineTo(118, fold + 6);
  g.lineTo(118, 154);
  g.lineTo(10, 154);
  g.closePath();
  g.fillStyle = 'rgba(10, 16, 24, 0.55)';
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.stroke();
  // folded corner
  g.beginPath();
  g.moveTo(128 - fold - 10, 6);
  g.lineTo(128 - fold - 10, fold + 6);
  g.lineTo(118, fold + 6);
  g.closePath();
  g.fillStyle = color;
  g.globalAlpha = 0.5;
  g.fill();
  g.globalAlpha = 1;
  // hologram text lines
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.globalAlpha = 0.55;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.moveTo(24, 44 + i * 20);
    g.lineTo(24 + 70 - (i % 3) * 18, 44 + i * 20);
    g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  cardTextureCache.set(color, tex);
  return tex;
}

function AgentCore({ scanning }: { scanning: boolean }) {
  const halo = useRef<THREE.Sprite>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const haloMap = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,195,110,0.95)');
    grad.addColorStop(0.3, 'rgba(255,170,70,0.35)');
    grad.addColorStop(1, 'rgba(255,160,60,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (halo.current) halo.current.scale.setScalar(2.1 + Math.sin(t * 1.3) * 0.18);
    if (pulse.current) {
      // scanning: rings expand from the core toward the shell
      const phase = (t % 1.4) / 1.4;
      const visible = scanning;
      pulse.current.visible = visible;
      if (visible) {
        const s = 0.3 + phase * R * 1.05;
        pulse.current.scale.setScalar(s);
        (pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - phase);
      }
    }
  });

  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.3, 32, 32]} />
        <meshBasicMaterial color="#ffc678" />
      </mesh>
      <sprite ref={halo} scale={[2.1, 2.1, 1]}>
        <spriteMaterial map={haloMap} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <mesh ref={pulse} rotation={[Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[1, 0.02, 8, 64]} />
        <meshBasicMaterial color="#ffb454" transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight intensity={50} distance={30} color="#ffd9a0" />
    </group>
  );
}

interface FileNode {
  doc: Document;
  color: string;
  pos: THREE.Vector3;
  catIndex: number;
  sparks: [number, number, number][];
}

function FileCard({ node, isHit, hitCount, onHover, onSelect }: {
  node: FileNode;
  isHit: boolean;
  hitCount: number;
  onHover: (h: { doc: Document; x: number; y: number } | null) => void;
  onSelect: (docId: string) => void;
}) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const seed = node.doc.id.length + node.catIndex * 7;

  useFrame(({ clock }) => {
    if (!mat.current) return;
    const t = clock.elapsedTime;
    // holographic flicker, brighter when hit
    const base = isHit ? 1 : 0.72;
    mat.current.opacity = base + Math.sin(t * (2.2 + (seed % 3) * 0.7) + seed) * 0.14;
  });

  const texture = fileCardTexture(node.color);
  const scale: [number, number] = isHit ? [0.42, 0.525] : [0.3, 0.375];

  return (
    <group position={node.pos}>
      <Billboard>
        <mesh
          onPointerOver={(e) => { e.stopPropagation(); onHover({ doc: node.doc, x: e.clientX ?? 0, y: e.clientY ?? 0 }); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { onHover(null); document.body.style.cursor = ''; }}
          onClick={(e) => { e.stopPropagation(); onSelect(node.doc.id); }}
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
        <Text
          position={[0, -0.33, 0]}
          fontSize={0.105}
          color={isHit ? '#ffffff' : '#aab8c6'}
          anchorX="center"
          outlineWidth={0.006}
          outlineColor="#080b10"
        >
          {node.doc.model}
        </Text>
        {isHit && hitCount > 0 && (
          <Text position={[0, 0.36, 0]} fontSize={0.09} color="#ffc678" anchorX="center" outlineWidth={0.005} outlineColor="#080b10">
            {`${hitCount} page${hitCount > 1 ? 's' : ''} cited`}
          </Text>
        )}
      </Billboard>

      {/* page dust cloud — the granular "amas" */}
      <points>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array(node.sparks.flat()), 3]}
          />
        </bufferGeometry>
        <pointsMaterial
          color={isHit ? '#ffffff' : node.color}
          size={isHit ? 0.045 : 0.028}
          transparent
          opacity={isHit ? 0.95 : 0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
        />
      </points>
    </group>
  );
}

function Scene({ onHover, onSelect }: {
  onHover: (h: { doc: Document; x: number; y: number } | null) => void;
  onSelect: (docId: string) => void;
}) {
  const { state, docs } = useApp();
  const shell = useRef<THREE.Group>(null);

  const { nodes, catAnchors } = useMemo(() => {
    const categories = [...new Set(docs.map((d) => d.category))].sort();
    const anchors: { label: string; dir: THREE.Vector3; color: string }[] = categories.map((label, i) => {
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
      // spread the category's docs inside its spherical cap
      const tangentA = new THREE.Vector3().crossVectors(anchor.dir, new THREE.Vector3(0, 1, 0)).normalize();
      const tangentB = new THREE.Vector3().crossVectors(anchor.dir, tangentA).normalize();
      const spreadA = rnd(ci * 13 + di * 7) * 0.34 + (di % 2 === 0 ? 0.14 : -0.14);
      const spreadB = rnd(ci * 29 + di * 11) * 0.3;
      const dir = anchor.dir.clone()
        .addScaledVector(tangentA, spreadA)
        .addScaledVector(tangentB, spreadB)
        .normalize();
      const pos = dir.multiplyScalar(R);
      const sparkCount = Math.min(doc.pages.length, 48);
      const sparks: [number, number, number][] = Array.from({ length: sparkCount }, (_, k) => [
        rnd(k * 3 + di) * 0.30,
        rnd(k * 5 + ci) * 0.30,
        rnd(k * 7 + di + ci) * 0.30,
      ]);
      out.push({ doc, color: anchor.color, pos, catIndex: ci, sparks });
    }
    return { nodes: out, catAnchors: anchors };
  }, [docs]);

  const hitByDoc = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of state.highlight) m.set(h.docId, (m.get(h.docId) ?? 0) + 1);
    return m;
  }, [state.highlight]);


  return (
    <>
      <color attach="background" args={['#080b10']} />
      <ambientLight intensity={0.3} />
      <Stars radius={42} depth={26} count={2800} factor={3.2} saturation={0} fade speed={0.5} />

      <AgentCore scanning={state.scanning} />
      <Billboard position={[0, -0.78, 0]}>
        <Text fontSize={0.17} color="#ffc678" letterSpacing={0.28} anchorX="center" outlineWidth={0.006} outlineColor="#080b10">
          AGENT
        </Text>
      </Billboard>

      <group ref={shell}>
        {/* faint shell wireframe: the planet's ghost surface */}
        <mesh>
          <sphereGeometry args={[R, 28, 20]} />
          <meshBasicMaterial color="#1b2530" wireframe transparent opacity={0.16} depthWrite={false} />
        </mesh>

        {catAnchors.map((c) => (
          <Billboard key={c.label} position={c.dir.clone().multiplyScalar(R + 0.42).toArray()}>
            <Text
              fontSize={0.11}
              color={c.color}
              anchorX="center"
              letterSpacing={0.08}
              outlineWidth={0.007}
              outlineColor="#080b10"
            >
              {c.label.toUpperCase()}
            </Text>
          </Billboard>
        ))}

        {nodes.map((n) => (
          <group key={n.doc.id}>
            {hitByDoc.has(n.doc.id) && (
              <Line
                points={[[0, 0, 0], n.pos.toArray()]}
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
              isHit={hitByDoc.has(n.doc.id)}
              hitCount={hitByDoc.get(n.doc.id) ?? 0}
              onHover={onHover}
              onSelect={onSelect}
            />
          </group>
        ))}
      </group>

      <OrbitControls
        enablePan={false}
        minDistance={4.0}
        maxDistance={12}
        maxPolarAngle={Math.PI * 0.72}
        minPolarAngle={Math.PI * 0.2}
      />
    </>
  );
}

export function Galaxy3D({ onSelectDoc }: { onSelectDoc?: (docId: string) => void }) {
  const [hover, setHover] = useState<{ doc: Document; x: number; y: number } | null>(null);
  return (
    <div className="galaxy-wrap">
      <Canvas camera={{ position: [0, 2.0, 7.4], fov: 42 }} dpr={[1, 2]}>
        <Scene onHover={setHover} onSelect={(id) => onSelectDoc?.(id)} />
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
