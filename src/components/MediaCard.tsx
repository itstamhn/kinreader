import React, { useState } from 'react';
import { Maximize2, Minimize2, Image as ImageIcon } from 'lucide-react';

interface MediaCardProps {
  imageUrl?: string;
  caption?: string;
}

export function MediaCard({ imageUrl, caption }: MediaCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!imageUrl) {
    return null;
  }

  return (
    <div className="w-full max-w-sm mx-auto my-2 px-2 transition-all">
      <div className="relative group rounded-2xl overflow-hidden border border-gray-800/80 bg-[#14141e] shadow-2xl p-2.5">
        {/* Pinned visual display */}
        <div className="relative w-full aspect-square max-h-56 sm:max-h-64 rounded-xl overflow-hidden bg-black/40 flex items-center justify-center">
          <img
            src={imageUrl}
            alt={caption || 'Article Visual'}
            className="w-full h-full object-contain transition-transform duration-300 group-hover:scale-105"
            onError={(e) => {
              // Hide if load error
              (e.target as HTMLElement).style.display = 'none';
            }}
          />

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur-md text-gray-300 hover:text-white transition opacity-0 group-hover:opacity-100"
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>

        {caption && (
          <p className="text-[11px] text-gray-400 text-center mt-2 font-mono truncate">
            {caption}
          </p>
        )}
      </div>

      {/* Expanded Lightbox Modal */}
      {isExpanded && (
        <div
          onClick={() => setIsExpanded(false)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
        >
          <img
            src={imageUrl}
            alt={caption || 'Full view'}
            className="max-w-full max-h-[85vh] rounded-2xl object-contain shadow-2xl border border-gray-800"
          />
        </div>
      )}
    </div>
  );
}
