// The technician copilot: a glass panel over the universe. The chat narrates
// on the left; the universe animates the retrieval on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, GuidedStep } from '../../agent/types';
import { useStepRunner } from '../hooks/useStepRunner';
import { useApp } from '../store';
import { Timeline } from './Timeline';
import { WorkOrderView } from './WorkOrderView';
import './conversation.css';

/** Minimal renderer for grounded answers: ## headings, - bullets, paragraphs. */
function AnswerBlock({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="step-answer">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\s*[-*]\s+/, '')}</li>)}</ul>;
        }
        if (/^#{1,4}\s+/.test(lines[0])) {
          return (
            <div key={i}>
              <h4>{lines[0].replace(/^#{1,4}\s+/, '')}</h4>
              {lines.length > 1 && <p>{lines.slice(1).join(' ')}</p>}
            </div>
          );
        }
        return <p key={i}>{b}</p>;
      })}
    </div>
  );
}

const isAction = (t: string) =>
  /^(report-measurement:|find-video$|order-part:|show-citation:|compile-work-order$|open-ingest$|explain-deep$)/.test(t);

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

function CiteChips({ citations, onOpen }: { citations: Citation[]; onOpen: (c: Citation) => void }) {
  if (citations.length === 0) return null;
  // Several documents cited in one step: name each chip's source doc.
  const multiDoc = new Set(citations.map((c) => c.docId)).size > 1;
  return (
    <div className="cite-chips">
      {citations.map((c, i) => (
        <button key={i} className="cite-chip" onClick={() => onOpen(c)} title={c.quote ?? c.label}>
          <span className="mono cite-chip-loc">
            {c.timestamp !== undefined
              ? `@ ${Math.floor(c.timestamp / 60)}:${String(c.timestamp % 60).padStart(2, '0')}`
              : `p.${c.page}`}
          </span>
          <span className="cite-chip-title">
            {multiDoc ? `${c.docId.split('-').slice(0, 2).join(' ')} · ` : ''}
            {c.title ?? c.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function StepCard({ step, isLast, onAction, onOpenCite, onOpenPage }: {
  step: GuidedStep;
  isLast: boolean;
  onAction: (action: string) => void;
  onOpenCite: (c: Citation) => void;
  onOpenPage: (docId: string, page: number) => void;
}) {
  const statusColor =
    step.status === 'ok' ? 'var(--ok)' : step.status === 'no-evidence' ? 'var(--warn)' : step.status === 'error' ? 'var(--err)' : 'var(--info)';
  return (
    <article className={`step-card panel fade-up ${step.status}`}>
      <header className="step-head">
        <span className="step-index mono">STEP {step.index + 1}</span>
        <span className="step-status mono" style={{ color: statusColor }}>{step.status.toUpperCase()}</span>
      </header>
      <Timeline events={step.phaseEvents} running={false} onOpenPage={onOpenPage} />
      {step.answer ? <AnswerBlock text={step.answer} /> : <p className="step-instruction">{step.instruction}</p>}
      <CiteChips citations={step.citations} onOpen={onOpenCite} />
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

  useEffect(() => {
    if (conv && conv.steps.length === 0 && !live.running && !startedRef.current) {
      startedRef.current = true;
      void run();
    }
  }, [conv, live.running, run]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' });
  }, [live.events.length, conv?.steps.length]);

  const lastCitations = useMemo(() => {
    const last = conv ? [...conv.steps].reverse().find((s) => s.citations.length > 0) : undefined;
    return last?.citations ?? [];
  }, [conv]);

  if (!conv) return null;

  const hasCompilableStep = conv.steps.some((s) => s.status === 'ok' && s.diagnosis);
  const openCite = (c: Citation) => dispatch({ type: 'open-lightbox', docId: c.docId, page: c.page });
  const openPage = (docId: string, page: number) => dispatch({ type: 'open-lightbox', docId, page });

  const onAction = (action: string) => {
    if (action === 'compile-work-order' || action.startsWith('order-part:')) {
      setShowWorkOrder(true);
    } else if (action === 'open-ingest') {
      dispatch({ type: 'open-center' });
    } else if (action.startsWith('show-citation:')) {
      const idx = Number(action.split(':')[1] ?? 0);
      const c = lastCitations[idx] ?? lastCitations[0];
      if (c) openCite(c);
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

      <div className="conv-stream" ref={streamRef}>
        {conv.steps.map((s, i) => (
          <div key={s.index} className="step-group">
            {s.userInput && !isAction(s.userInput) && (
              <div className="user-bubble fade-up">{s.userInput}</div>
            )}
            <StepCard
              step={s}
              isLast={i === conv.steps.length - 1 && !live.running}
              onAction={onAction}
              onOpenCite={openCite}
              onOpenPage={openPage}
            />
          </div>
        ))}
        {live.running && live.userInput && !isAction(live.userInput) && (
          <div className="user-bubble fade-up">{live.userInput}</div>
        )}
        {live.running && (
          <article className="step-card panel live">
            <header className="step-head">
              <span className="step-index mono">STEP {conv.steps.length + 1}</span>
              <span className="step-status mono live-chip">
                <span className="live-dot" />
                {state.driverKind === 'vultr' ? 'REASONING ON VULTR' : 'REASONING'}
              </span>
            </header>
            <Timeline events={live.events} running onOpenPage={openPage} />
          </article>
        )}
      </div>

      <FreeReply disabled={live.running} onSend={(text) => void run(text)} />

      {showWorkOrder && (
        <WorkOrderView conversation={conv} docs={docs} onClose={() => setShowWorkOrder(false)} />
      )}
    </section>
  );
}

function FreeReply({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <div className="conv-reply">
      <input
        placeholder={disabled ? 'The agent is working…' : 'Answer the agent or ask anything about this repair…'}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button className="btn" onClick={submit} disabled={disabled || !text.trim()} title="Send">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}
