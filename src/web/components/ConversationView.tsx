// The technician copilot cockpit: streaming reasoning timeline, cited pages,
// adaptive guided steps, and the compiled work order.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, GuidedStep } from '../../agent/types';
import { useStepRunner } from '../hooks/useStepRunner';
import { useApp } from '../store';
import { CitationPanel } from './CitationPanel';
import { Timeline } from './Timeline';
import { WorkOrderView } from './WorkOrderView';
import './conversation.css';

function ConfidenceMeter({ value, reason }: { value: number; reason: string }) {
  const color = value >= 0.7 ? 'var(--ok)' : value >= 0.4 ? 'var(--warn)' : 'var(--err)';
  return (
    <div className="conf">
      <div className="conf-bar">
        <div className="conf-fill" style={{ width: `${value * 100}%`, background: color }} />
      </div>
      <span className="conf-value mono" style={{ color }}>{(value * 100).toFixed(0)}%</span>
      <span className="conf-reason">{reason}</span>
    </div>
  );
}

function StepCard({ step, isLast, onAction }: { step: GuidedStep; isLast: boolean; onAction: (action: string) => void }) {
  const statusColor =
    step.status === 'ok' ? 'var(--ok)' : step.status === 'no-evidence' ? 'var(--warn)' : step.status === 'error' ? 'var(--err)' : 'var(--info)';
  return (
    <article className={`step-card panel fade-up ${step.status}`}>
      <header className="step-head">
        <span className="step-index mono">STEP {step.index + 1}</span>
        <span className="step-status mono" style={{ color: statusColor }}>{step.status.toUpperCase()}</span>
      </header>
      <Timeline events={step.phaseEvents} running={false} />
      <p className="step-instruction">{step.instruction}</p>
      <ConfidenceMeter value={step.confidence} reason={step.confidenceReason} />
      {isLast && step.proposedNext.length > 0 && (
        <div className="step-actions">
          {step.proposedNext.map((p) => (
            <button key={p.action + p.label} className="btn" onClick={() => onAction(p.action)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

export function ConversationView({ id }: { id: string }) {
  const { state, dispatch, docs } = useApp();
  const conv = state.conversations.find((c) => c.id === id);
  const { live, run } = useStepRunner(id);
  const [showWorkOrder, setShowWorkOrder] = useState(false);
  const startedRef = useRef(false);
  const streamRef = useRef<HTMLDivElement>(null);

  // Auto-run the first step when the conversation opens fresh.
  useEffect(() => {
    if (conv && conv.steps.length === 0 && !live.running && !startedRef.current) {
      startedRef.current = true;
      void run();
    }
  }, [conv, live.running, run]);

  // Keep the stream scrolled to the newest event.
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
  }, [live.events.length, conv?.steps.length]);

  const panelCitations: Citation[] = useMemo(() => {
    if (live.running) {
      const withCites = [...live.events].reverse().find((e) => e.citations && e.citations.length > 0);
      if (withCites?.citations) return withCites.citations;
    }
    const lastWithCites = conv ? [...conv.steps].reverse().find((s) => s.citations.length > 0) : undefined;
    return lastWithCites?.citations ?? [];
  }, [conv, live.events, live.running]);

  if (!conv) return null;

  const hasCompilableStep = conv.steps.some((s) => s.status === 'ok' && s.diagnosis);

  const onAction = (action: string) => {
    if (action === 'compile-work-order' || action.startsWith('order-part:')) {
      setShowWorkOrder(true);
    } else if (action === 'open-ingest') {
      dispatch({ type: 'open-center' });
    } else if (action.startsWith('show-citation:')) {
      // citations already visible in the panel; no-op selector for now
    } else {
      void run(action || undefined);
    }
  };

  return (
    <section className="conv">
      <header className="conv-head">
        <div>
          <h1 className="conv-device">{conv.device}</h1>
          <div className="conv-symptom">{conv.symptom}</div>
        </div>
        <div className="conv-head-actions">
          {conv.attachments.length > 0 && (
            <img className="conv-photo" src={conv.attachments[0].dataUrl} alt="Technician attachment" title={conv.attachments[0].name} />
          )}
          {hasCompilableStep && (
            <button className="btn btn-primary" onClick={() => setShowWorkOrder(true)}>
              Work order
            </button>
          )}
        </div>
      </header>

      <div className="conv-body">
        <div className="conv-stream" ref={streamRef}>
          {conv.steps.map((s, i) => (
            <StepCard
              key={s.index}
              step={s}
              isLast={i === conv.steps.length - 1 && !live.running}
              onAction={onAction}
            />
          ))}
          {live.running && (
            <article className="step-card panel live">
              <header className="step-head">
                <span className="step-index mono">STEP {conv.steps.length + 1}</span>
                <span className="step-status mono live-chip">
                  <span className="live-dot" />
                  {state.driverKind === 'vultr' ? 'REASONING ON VULTR' : 'REASONING'}
                </span>
              </header>
              <Timeline events={live.events} running />
            </article>
          )}
        </div>

        <aside className="conv-side">
          <CitationPanel citations={panelCitations} docs={docs} />
        </aside>
      </div>

      {showWorkOrder && (
        <WorkOrderView conversation={conv} docs={docs} onClose={() => setShowWorkOrder(false)} />
      )}
    </section>
  );
}
