// Drives one conversation step: consumes the runStep async generator, feeding
// phase events to the timeline as they happen and pulsing the galaxy on hits.
import { useCallback, useRef, useState } from 'react';
import { runStep } from '../../agent/loop';
import type { GuidedStep, Phase, PhaseEvent } from '../../agent/types';
import { getDriver } from '../driver-factory';
import { speakVerdict } from '../tts';
import { useApp } from '../store';

export interface LiveStep {
  events: PhaseEvent[];
  running: boolean;
  currentPhase?: Phase;
  userInput?: string;
}

export function useStepRunner(conversationId: string) {
  const { state, dispatch, docs } = useApp();
  const [live, setLive] = useState<LiveStep>({ events: [], running: false });
  const runningRef = useRef(false);

  const run = useCallback(
    async (userInput?: string) => {
      if (runningRef.current) return;
      const conv = state.conversations.find((c) => c.id === conversationId);
      if (!conv) return;
      runningRef.current = true;
      setLive({ events: [], running: true, userInput });
      try {
        const driver = await getDriver(state.driverKind);
        const gen = runStep({ conversation: conv, docs, userInput }, driver);
        // First hit of the step replaces the previous step's highlight; later
        // hits accumulate so the universe expands with each re-retrieve.
        let firstHit = true;
        while (true) {
          const n = await gen.next();
          if (n.done) {
            dispatch({ type: 'append-step', conversationId, step: { ...n.value, userInput } });
            // Spoken verdict: fire-and-forget, gated inside speakVerdict.
            if (n.value.status !== 'error') void speakVerdict(n.value.instruction, state.lang, state.driverKind);
            break;
          }
          const e = n.value;
          setLive((prev) => ({ ...prev, events: [...prev.events, e], running: true, currentPhase: e.phase }));
          if (e.phase === 'retrieve') {
            if (e.hitPages) {
              dispatch({ type: 'set-scanning', scanning: false });
              if (e.hitPages.length > 0) {
                dispatch({ type: firstHit ? 'set-highlight' : 'add-highlight', pages: e.hitPages });
                firstHit = false;
              }
            } else {
              dispatch({ type: 'set-scanning', scanning: true });
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorStep: GuidedStep = {
          index: state.conversations.find((c) => c.id === conversationId)?.steps.length ?? 0,
          phaseEvents: [],
          instruction: `The inference call failed: ${message}. Retry, or switch to the offline script with Ctrl+Shift+D.`,
          citations: [],
          proposedNext: [{ label: 'Retry', action: userInput ?? '' }],
          confidence: 0.05,
          confidenceReason: 'step failed before evidence was gathered',
          status: 'error',
        };
        dispatch({ type: 'append-step', conversationId, step: errorStep });
      } finally {
        dispatch({ type: 'set-scanning', scanning: false });
        runningRef.current = false;
        setLive((prev) => ({ ...prev, running: false }));
      }
    },
    [conversationId, dispatch, docs, state.conversations, state.driverKind],
  );

  return { live, run };
}
