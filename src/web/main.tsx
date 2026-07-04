import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/index.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import './tokens.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
