import { createRoot } from 'react-dom/client';

// iOS: Safari never resizes the layout viewport when the virtual keyboard
// opens, so bottom-anchored bars vanish under it. Track the overlap in --kb
// (only while a field is focused: pinch-zooming the page also shrinks the
// visual viewport and must not move the bars).
const vv = window.visualViewport;
if (vv) {
  const updateKb = () => {
    const el = document.activeElement;
    const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    const kb = typing ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
  };
  vv.addEventListener('resize', updateKb);
  vv.addEventListener('scroll', updateKb);
  window.addEventListener('focusin', updateKb);
  window.addEventListener('focusout', () => setTimeout(updateKb, 50));
}
import '@fontsource-variable/inter/index.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import './tokens.css';
import { App } from './App';
// LAST import: finger-size overrides must win the cascade over component CSS
import './touch.css';

createRoot(document.getElementById('root')!).render(<App />);
