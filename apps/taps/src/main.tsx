import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

const host = document.getElementById('root');
if (!host) throw new Error('a janela abriu sem o elemento #root');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
