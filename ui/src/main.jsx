import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import BattlePage from './BattlePage.jsx';
import './styles.css';

function Root() {
  const isBattle = window.location.pathname.startsWith('/battle');
  if (isBattle) {
    return <BattlePage onBack={() => { window.location.href = '/'; }} />;
  }
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
