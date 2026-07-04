// Workspace self-check: the agent audits itself on freshly dropped documents.
// Probe questions are written FROM single pages; the real agent loop must
// find and cite them across the whole corpus. Trust, demonstrated live.
import { useCallback, useState } from 'react';
import type { SelfCheckItem } from '../../agent/selfcheck';
import { runSelfCheck } from '../../agent/selfcheck';
import { getDriver } from '../driver-factory';
import { useApp } from '../store';
import './selfcheck.css';

export function SelfCheckPanel({ docIds, onClose }: { docIds: string[]; onClose: () => void }) {
  const { state, docs, dispatch } = useApp();
  const [items, setItems] = useState<SelfCheckItem[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');

  const run = useCallback(async () => {
    setPhase('running');
    setItems([]);
    const driver = await getDriver(state.driverKind);
    // Probes come from the new docs, but the agent searches the whole
    // workspace - exactly like a real user question would.
    await runSelfCheck(docs, driver, {
      count: 3,
      probeDocIds: docIds,
      onItem: (item) => setItems((prev) => [...prev, item]),
    });
    setPhase('done');
  }, [state.driverKind, docs, docIds]);

  const passed = items.filter((i) => i.passed).length;

  return (
    <aside className="selfcheck panel fade-up">
      <header className="selfcheck-head">
        <span className="mono selfcheck-title">WORKSPACE SELF-CHECK</span>
        <button className="selfcheck-close" onClick={onClose} title="Dismiss">×</button>
      </header>

      {phase === 'idle' && (
        <>
          <p className="selfcheck-blurb">
            The agent writes probe questions from your documents, then answers them
            cold over the whole workspace. Each answer must quote the printed facts
            and cite the source page.
          </p>
          <button className="btn btn-primary selfcheck-run" onClick={() => void run()}>
            Run self-check
          </button>
        </>
      )}

      {phase !== 'idle' && (
        <div className="selfcheck-items">
          {items.map((it, i) => (
            <div key={i} className={`selfcheck-item ${it.passed ? 'pass' : 'fail'}`}>
              <div className="selfcheck-verdict mono">{it.passed ? 'PASS' : 'MISS'}</div>
              <div className="selfcheck-q">{it.question}</div>
              <button
                className="selfcheck-cite mono"
                onClick={() => dispatch({ type: 'open-lightbox', docId: it.docId, page: it.page })}
              >
                source p.{it.page}
              </button>
            </div>
          ))}
          {phase === 'running' && (
            <div className="selfcheck-item running">
              <span className="live-dot" />
              <span className="selfcheck-q">The agent is answering its own audit…</span>
            </div>
          )}
          {phase === 'done' && (
            <div className="selfcheck-score mono">
              {passed}/{items.length} probes verified{passed === items.length && items.length > 0 ? ' - the agent finds and cites your documents correctly' : ''}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
