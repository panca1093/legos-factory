import { createRoot } from 'react-dom/client';
import { Root } from './App.tsx';
import { applyTheme, storage } from './api.ts';
import './styles.css';

applyTheme((storage('lf:theme') as 'system' | 'light' | 'dark' | null) ?? 'system');
createRoot(document.getElementById('root')!).render(<Root />);
