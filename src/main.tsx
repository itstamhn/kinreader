import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ConvexAppProvider } from './lib/convex';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexAppProvider>
      <App />
    </ConvexAppProvider>
  </React.StrictMode>
);
