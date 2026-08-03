'use client';

import { useState } from 'react';
import { usePermissions } from '@/context/PermissionContext';

export default function AiChat() {
  const { role, can } = usePermissions();
  const [messages, setMessages] = useState<{role: string, content: string}[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input };
    const allMessages = [...messages, userMessage];
    setMessages(allMessages);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: allMessages.map(m => ({ role: m.role, content: m.content }))
        })
      });

      const data = await res.json();
      
      if (data.error) throw new Error(data.error);

      setMessages(prev => [...prev, { role: 'assistant', content: data.answer }]);
    } catch (error: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${error.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  // EMPLOYEE and VIEWER roles have no finance AI access
  const hasAiAccess = can('REPORT_READ') || can('BANK_READ') || can('EXPENSE_READ') || can('PROJECT_READ');

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center mt-20">
            <p className="text-gray-400 dark:text-gray-500 text-sm">
              {hasAiAccess 
                ? 'Ask about reports, balances, budgets, or project profitability...'
                : 'Your role does not have finance data access through AI.'}
            </p>
            {hasAiAccess && (
              <p className="text-gray-300 dark:text-gray-600 text-xs mt-2">
                Role: {role} | Read-only access to authorized reports
              </p>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div 
              className={`max-w-[80%] p-3 rounded-lg text-sm ${
                m.role === 'user' 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 p-3 rounded-lg text-sm animate-pulse">
              Querying authorized reports...
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={hasAiAccess ? 'Ask about your finance data...' : 'No AI access for your role'}
          className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading || !hasAiAccess}
        />
        <button 
          type="submit" 
          className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          disabled={isLoading || !hasAiAccess}
        >
          Send
        </button>
      </form>
    </div>
  );
}