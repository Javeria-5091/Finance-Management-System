'use client';

import { useEffect } from 'react';
import { X, Sparkles } from 'lucide-react'; 
import AiChat from './AiChat'; 

interface AiChatSlideOverProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AiChatSlideOver({ isOpen, onClose }: AiChatSlideOverProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
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
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-md flex flex-col bg-white dark:bg-gray-900 shadow-2xl border-l border-gray-200 dark:border-gray-800 transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
             <div className="p-1.5 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
                <Sparkles size={16} className="text-indigo-600 dark:text-indigo-400" />
             </div>
             <h2 className="text-base font-semibold text-gray-900 dark:text-white">OSYSTIC Finance AI</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          <AiChat />
        </div>
      </div>
    </>
  );
}