// The Repair Center view: full-bleed galaxy, floating command card, tree drawer.
import { useState } from 'react';
import { GalaxyCanvas } from './GalaxyCanvas';
import { NewConversation } from './NewConversation';
import { TreePanel } from './TreePanel';
import './galaxy.css';

export function GalaxyView() {
  const [showTree, setShowTree] = useState(false);
  return (
    <section className="galaxy-view">
      <GalaxyCanvas />
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
