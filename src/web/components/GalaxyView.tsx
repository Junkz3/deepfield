// The Repair Center view: full-bleed 3D galaxy, floating command card, tree drawer.
import { lazy, Suspense, useState } from 'react';
import { NewConversation } from './NewConversation';
import { TreePanel } from './TreePanel';
import './galaxy.css';

const Galaxy3D = lazy(() => import('./Galaxy3D').then((m) => ({ default: m.Galaxy3D })));

export function GalaxyView() {
  const [showTree, setShowTree] = useState(false);
  return (
    <section className="galaxy-view">
      <Suspense fallback={<div className="galaxy-loading mono">Charting the knowledge galaxy…</div>}>
        <Galaxy3D />
      </Suspense>
      <button className={`galaxy-tree-toggle btn ${showTree ? 'active' : ''}`} onClick={() => setShowTree(!showTree)}>
        Knowledge tree
      </button>
      {showTree && (
        <div className="galaxy-tree-drawer fade-up">
          <TreePanel />
        </div>
      )}
      <div className="galaxy-command">
        <NewConversation />
      </div>
    </section>
  );
}
