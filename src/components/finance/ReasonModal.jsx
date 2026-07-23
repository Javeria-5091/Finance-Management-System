'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

export default function ReasonModal({ open, title, description = string, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onCancel} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"><X size={20} /></button>
        </div>
        
        <div className="p-4">
          {description && <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{description}</p>}
          
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason *</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full p-3 border dark:border-gray-600 rounded-lg bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 mb-2 text-sm"
            placeholder="Please provide a detailed reason..."
            autoFocus
          />
        </div>

        <div className="flex justify-end gap-3 p-4 border-t dark:border-gray-700">
          <button onClick={onCancel} className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
            Cancel
          </button>
          <button 
            onClick={() => onConfirm(reason)} 
            disabled={!reason.trim()} 
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}