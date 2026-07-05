// The enterprise deliverable: a compiled, cited work order. The demo ends here.
import { createPortal } from 'react-dom';
import { compileWorkOrder } from '../../agent/loop';
import type { Conversation, Document, WorkOrder } from '../../agent/types';

function buildMarkdown(wo: WorkOrder): string {
  const lines = [
    `# Work Order — ${wo.device}`,
    ``,
    `**Symptom:** ${wo.symptom}`,
    `**Diagnosis:** ${wo.diagnosis.component}`,
    `**Cause:** ${wo.diagnosis.cause}`,
    `**Confidence:** ${(wo.confidence * 100).toFixed(0)}% (${wo.confidenceReason})`,
    ``,
    `## Procedure`,
    ...wo.procedure.map((p, i) => `${i + 1}. ${p}`),
    ...(wo.parts.length > 0
      ? [``, `## Parts`, ...wo.parts.map((p) => `- ${p.ref} — ${p.name} — ${p.inStock ? `in stock${p.price ? `, $${p.price}` : ''}` : `lead time ${p.leadDays ?? '?'}d`}`)]
      : []),
    ...(wo.safety.length > 0 ? [``, `## Safety`, ...wo.safety.map((s) => `- ${s}`)] : []),
    ``,
    `## Citations`,
    ...wo.citations.map((c) => `- ${c.label}${c.quote ? ` — "${c.quote}"` : ''}`),
  ];
  if (wo.missingDocs.length > 0) {
    lines.push(``, `## Missing documents`, ...wo.missingDocs.map((m) => `- ${m}`));
  }
  return lines.join('\n');
}

export function WorkOrderView({ conversation, docs, onClose }: { conversation: Conversation; docs: Document[]; onClose: () => void }) {
  const lastOk = [...conversation.steps].reverse().find((s) => s.status === 'ok' && s.diagnosis);
  if (!lastOk?.diagnosis) return null;
  const wo = compileWorkOrder(
    conversation,
    lastOk.diagnosis,
    lastOk.parts ?? [],
    lastOk.safety ?? { lines: [], citations: [] },
  );
  void docs;

  const download = () => {
    const blob = new Blob([buildMarkdown(wo)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `work-order-${conversation.device.toLowerCase().replace(/\s+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const confColor = wo.confidence >= 0.7 ? 'var(--ok)' : wo.confidence >= 0.4 ? 'var(--warn)' : 'var(--err)';

  // The overlay is position:fixed, but a conversation renders it inside the
  // glass .conv-panel, whose backdrop-filter makes it the containing block for
  // fixed descendants (and overflow:hidden clips them). Portal to <body> so the
  // work order is the full-viewport centered modal its CSS was built for.
  return createPortal(
    <div className="wo-overlay" onClick={onClose}>
      <article className="wo-sheet fade-up" onClick={(e) => e.stopPropagation()}>
        <header className="wo-head">
          <div>
            <div className="wo-eyebrow mono">WORK ORDER</div>
            <h2>{wo.device}</h2>
            <div className="wo-symptom">{wo.symptom}</div>
          </div>
          <div className="wo-head-right">
            <div className="wo-conf" style={{ borderColor: confColor, color: confColor }}>
              {(wo.confidence * 100).toFixed(0)}%
            </div>
            <div className="wo-conf-reason">{wo.confidenceReason}</div>
          </div>
        </header>

        <section className="wo-grid">
          <div className="wo-block">
            <h3>Diagnosis</h3>
            <p className="wo-component">{wo.diagnosis.component}</p>
            <p className="wo-cause">{wo.diagnosis.cause}</p>
          </div>

          {wo.parts.length > 0 && (
            <div className="wo-block">
              <h3>Parts</h3>
              <table className="wo-parts">
                <tbody>
                  {wo.parts.map((p) => (
                    <tr key={p.ref}>
                      <td className="mono">{p.ref}</td>
                      <td>{p.name}</td>
                      <td className={p.inStock ? 'ok' : 'warn'}>
                        {p.inStock ? `in stock${p.price ? ` · $${p.price}` : ''}` : `lead ${p.leadDays ?? '?'}d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="wo-block wide">
            <h3>Procedure</h3>
            <ol className="wo-procedure">
              {wo.procedure.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          </div>

          {wo.safety.length > 0 && (
            <div className="wo-block">
              <h3>Safety</h3>
              <ul className="wo-safety">
                {wo.safety.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="wo-block">
            <h3>Citations</h3>
            <ul className="wo-cites mono">
              {wo.citations.map((c, i) => (
                <li key={i}>{c.label}</li>
              ))}
            </ul>
            {wo.missingDocs.length > 0 && (
              <>
                <h3 className="warn">Missing documents</h3>
                <ul className="wo-missing">
                  {wo.missingDocs.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        <footer className="wo-foot">
          <button className="btn btn-primary" onClick={download}>Download Markdown</button>
          <button className="btn" onClick={onClose}>Close</button>
        </footer>
      </article>
    </div>,
    document.body,
  );
}
