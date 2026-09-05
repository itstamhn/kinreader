import React from 'react';
import type { CreationInput } from '../hooks/useArticleCreation';
import { ListeningSheet } from './listening/ListeningSheets';
export function ClipboardDetectSheet({ isOpen, detectedUrl, onClose, onCreate }: { isOpen: boolean; detectedUrl: string; onClose: () => void; onCreate: (input: CreationInput) => void }) {
  if (!isOpen || !detectedUrl) return null;
  return <ListeningSheet title="Create audio from this link?" onClose={onClose}>
    <p className="listening-raw-url">{detectedUrl}</p>
    <button className="listening-primary" onClick={() => { onClose(); onCreate({ sourceUrl: detectedUrl }); }}>Create audio</button>
    <button className="listening-dismiss" onClick={onClose}>Dismiss</button>
  </ListeningSheet>;
}
