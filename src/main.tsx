import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ConvexAppProvider } from './lib/convex';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConvexAppProvider>
        <App />
      </ConvexAppProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
