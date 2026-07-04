import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mascot } from './components/Mascot';

describe('Mascot', () => {
  it('renders the requested mood class for every known mood', () => {
    for (const mood of ['idle', 'thinking', 'spark', 'oops']) {
      expect(renderToStaticMarkup(<Mascot mood={mood} />)).toContain(`mascot--${mood}`);
    }
  });

  it('falls back to idle for an unknown mood', () => {
    expect(renderToStaticMarkup(<Mascot mood="banana" />)).toContain('mascot--idle');
  });

  it('defaults to idle and applies the pixel size', () => {
    const html = renderToStaticMarkup(<Mascot size={64} />);
    expect(html).toContain('mascot--idle');
    expect(html).toContain('width="64"');
    expect(html).toContain('height="64"');
  });
});
