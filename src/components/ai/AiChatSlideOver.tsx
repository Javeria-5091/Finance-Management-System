'use client';

import { useEffect } from 'react';
import { X, Sparkles } from 'lucide-react';
import AiChat from './AiChat';

interface AiChatSlideOverProps {
  isOpen: boolean;
  onClose: () => void;
  isDark?: boolean;
}

export default function AiChatSlideOver({ isOpen, onClose, isDark = false }: AiChatSlideOverProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => { document.body.style.overflow = 'unset'; };
  }, [isOpen]);

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
      />

      <div
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-md flex flex-col shadow-2xl border-l transition-transform duration-300 ease-in-out ${
          isDark
            ? 'bg-gray-900 border-gray-800'
            : 'bg-white border-gray-200'
        } ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* ─── Header ─── */}
        <div className={`flex items-center justify-between px-5 py-4 border-b shrink-0 ${
          isDark ? 'border-gray-800' : 'border-gray-200'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-1.5 rounded-lg ${
              isDark ? 'bg-indigo-900/30' : 'bg-indigo-100'
            }`}>
              <Sparkles size={16} className="text-indigo-500" />
            </div>
            <div>
              <h2 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                OSYSTIC Finance AI
              </h2>
              <p className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Read-only permission-aware copilot
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-colors ${
              isDark
                ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
            }`}
          >
            <X size={18} />
          </button>
        </div>

        {/* ─── Chat Body ─── */}
        <div className="flex-1 min-h-0">
          <AiChat />
        </div>
      </div>
    </>
  );
}