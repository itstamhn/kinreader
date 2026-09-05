import { preparationLabel } from '../../utils/listeningSession';
import React from 'react';
import { ChevronLeft, PlusCircle, Settings } from 'lucide-react';
import type { SavedArticleItem } from '../LibraryDrawer';
import type { ArticleData } from '../../types';
export function ListeningLibrary({ items, onBack, onAdd, onSettings, onSelect }: {
  items: SavedArticleItem[]; onBack: () => void; onAdd: () => void; onSettings: () => void; onSelect: (article: ArticleData) => void;
}) {
  const minutes = (item: SavedArticleItem) => !item.article.content.trim() ? 0 : Math.max(1, Math.round(item.article.content.split(/\s+/).length / 177));
  return <section className="listening-library"><header className="listening-top"><button className="listening-icon" aria-label="Back to listening" onClick={onBack}><ChevronLeft size={18} /></button><div><button className="listening-icon" aria-label="Settings" onClick={onSettings}><Settings size={18} /></button><button className="listening-icon" aria-label="Add an article" onClick={onAdd}><PlusCircle size={18} /></button></div></header>
    <div className="listening-library-body"><h1>Your library</h1><p className="listening-library-summary">{items.length} {items.length === 1 ? 'article' : 'articles'} · about {items.reduce((sum, item) => sum + minutes(item), 0)} min</p>
      {items.length === 0 && <p className="listening-library-empty">Your next good read can be a listen. Add an article to get started.</p>}
      <div>{items.map(item => <button className="listening-library-row" key={item.id} onClick={() => onSelect(item.article)} data-finished={item.progress >= 98}>
        <span className="listening-library-meta"><span>{item.article.author || 'Article'}</span><span data-resume={item.progress > 0 && item.progress < 98}>{preparationLabel(item.article) || (item.progress >= 98 ? 'Finished' : item.progress > 0 ? `Resume · ${Math.max(1, Math.ceil(minutes(item) * (1 - item.progress / 100)))} min left` : `about ${minutes(item)} min`)}</span></span>
        <h2>{item.article.title}</h2><span className="listening-library-progress"><span style={{ width: `${Math.min(100, item.progress)}%` }} /></span>
      </button>)}</div>
    </div><footer className="listening-library-footer"><button className="listening-secondary-button" onClick={onAdd}>Add an article</button><p>Your library and listening progress are private.</p></footer>
  </section>;
}
