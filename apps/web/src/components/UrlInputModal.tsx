import React from 'react';
import type { CreationInput } from '../hooks/useArticleCreation';
import { ListeningSheet } from './listening/ListeningSheets';
import { ArticleCreationForm } from './listening/ArticleCreationForm';

export function UrlInputModal({ isOpen, onClose, onCreate }: { isOpen: boolean; onClose: () => void; onCreate: (input: CreationInput) => void }) {
  if (!isOpen) return null;
  return <ListeningSheet title="Create audio" onClose={onClose}><ArticleCreationForm onCreate={input => { onClose(); onCreate(input); }} /></ListeningSheet>;
}
