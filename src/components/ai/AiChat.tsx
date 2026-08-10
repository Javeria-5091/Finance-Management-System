'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePermissions } from '@/context/PermissionContext';
import { useAuth } from '@/context/AuthContext';
import {
  Send, ThumbsUp, ThumbsDown, RotateCcw, Sparkles,
  AlertTriangle, Info, Clock, BarChart3, ChevronDown,
  MessageSquare, X, CheckCircle, Filter
} from 'lucide-react';

// ─── Types matching Spec 9.10 AI response contract ───
interface AIMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  tool?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  period?: { from: string; to: string } | null;
  currency?: string | null;
  filters?: { field: string; value: string }[] | null;
  data_as_of?: string | null;
  warnings?: string[] | null;
  source_rows_or_report?: string | null;
  suggested_safe_actions?: string[] | null;
  timestamp?: string | null;
  feedbackGiven?: 'up' | 'down' | null;
}

interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  status: string;
}

// ─── Spec 9.10: Sanitize model output — strip any HTML/JS ───
function sanitizeContent(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<[^>]+on\w+\s*=/gi, '')
    .replace(/javascript:\s*/gi, '')
    .replace(/vbscript:\s*/gi, '')
    .replace(/data:\s*text\/html/gi, '');
}

export default function AiChat() {
  const { role, can } = usePermissions();
  const { user } = useAuth();
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pastConversations, setPastConversations] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // EMPLOYEE and VIEWER roles have limited/no finance AI access
  const hasAiAccess = can('REPORT_READ') || can('BANK_READ') || can('EXPENSE_READ') || can('PROJECT_READ') || can('TAX_READ') || can('GL_READ') || can('BUDGET_READ');

  // Fetch past conversations
  const fetchConversations = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/ai/conversations');
      if (res.ok) {
        const data = await res.json();
        setPastConversations(data.conversations || []);
      }
    } catch {}
  }, [user]);

  // Load a past conversation
  const loadConversation = async (convId: string) => {
    setShowHistory(false);
    try {
      const res = await fetch(`/api/ai/conversations/${convId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
        setConversationId(convId);
      }
    } catch {}
  };

  // Start new conversation
  const startNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setShowHistory(false);
  };

  // Submit feedback (Spec 9.9 ai_feedback)
  const submitFeedback = async (messageIndex: number, feedback: 'up' | 'down') => {
    const msg = messages[messageIndex];
    if (!msg?.id || msg.feedbackGiven) return;

    try {
      await fetch('/api/ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: msg.id,
          conversation_id: conversationId,
          feedback_type: 'message_rating',
          rating: feedback === 'up' ? 5 : 1,
        }),
      });

      setMessages(prev =>
        prev.map((m, i) => i === messageIndex ? { ...m, feedbackGiven: feedback } : m)
      );
    } catch {}
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: AIMessage = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    };
    const allMessages = [...messages, userMessage];
    setMessages(allMessages);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages.map(m => ({ role: m.role, content: m.content })),
          conversation_id: conversationId,
        }),
      });

      const data = await res.json();

      // Spec 9.10: Sanitize AI output before rendering
      const sanitizedAnswer = sanitizeContent(data.answer || data.error || 'No response received.');

      const assistantMessage: AIMessage = {
        role: 'assistant',
        content: sanitizedAnswer,
        tool: data.tool || data.metric_or_report || null,
        confidence: data.confidence || 'medium',
        period: data.period || null,
        currency: data.currency || 'PKR',
        filters: data.filters || null,
        data_as_of: data.data_as_of || null,
        warnings: data.warnings || [],
        source_rows_or_report: data.source_rows_or_report || null,
        suggested_safe_actions: data.suggested_safe_actions || [],
        timestamp: data.data_as_of || new Date().toISOString(),
        feedbackGiven: null,
      };

      setMessages(prev => [...prev, assistantMessage]);

      if (data.conversation_id) {
        setConversationId(data.conversation_id);
      }
    } catch (error: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${error.message}`,
        timestamp: new Date().toISOString(),
        confidence: 'low',
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Confidence badge color
  const getConfidenceColor = (c?: string | null) => {
    switch (c) {
      case 'high': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
      case 'medium': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
      case 'low': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
      default: return 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* ─── Header with new chat / history toggle ─── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={startNewConversation}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="New Chat"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchConversations(); }}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Chat History"
          >
            <MessageSquare size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${getConfidenceColor(undefined)} bg-gray-50 dark:bg-gray-800 text-gray-500`}>
            {role}
          </span>
        </div>
      </div>

      {/* ─── Conversation History Panel ─── */}
      {showHistory && (
        <div className="border-b border-gray-200 dark:border-gray-700 max-h-48 overflow-y-auto shrink-0">
          {pastConversations.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 p-3 text-center">No past conversations</p>
          ) : (
            pastConversations.slice(0, 10).map(conv => (
              <button
                key={conv.id}
                onClick={() => loadConversation(conv.id)}
                className="w-full text-left px-4 py-2 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-b border-gray-100 dark:border-gray-700/50 last:border-0"
              >
                <p className="truncate font-medium">{conv.title || 'Untitled'}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {new Date(conv.created_at).toLocaleDateString()}
                </p>
              </button>
            ))
          )}
        </div>
      )}

      {/* ─── Messages Area ─── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center mt-16">
            <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-900/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Sparkles size={24} className="text-indigo-500" />
            </div>
            <p className="text-gray-400 dark:text-gray-500 text-sm">
              {hasAiAccess
                ? 'Ask about cash position, P&L, budgets, project profitability, tax summaries...'
                : 'Your role does not have finance data access through AI.'}
            </p>
            {hasAiAccess && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {role !== 'EMPLOYEE' && (
                  <>
                    <SuggestionChip text="What is our cash position?" onClick={() => setInput('What is our cash position?')} />
                    <SuggestionChip text="Show P&L for this fiscal year" onClick={() => setInput('Show P&L for this fiscal year')} />
                    <SuggestionChip text="Which projects have lowest margin?" onClick={() => setInput('Which projects have the lowest margin in the last 90 days?')} />
                  </>
                )}
                {role === 'EMPLOYEE' && (
                  <SuggestionChip text="What is my expense claim status?" onClick={() => setInput('What is the status of my expense claims?')} />
                )}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] p-3 rounded-lg text-sm ${
                m.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
              }`}
            >
              {/* Spec 9.10: Render content as plain text — no dangerouslySetInnerHTML */}
              <p className="whitespace-pre-wrap">{m.content}</p>

              {/* ─── Assistant Message Metadata (Spec 9.10 response contract) ─── */}
              {m.role === 'assistant' && m.tool && (
                <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                  {/* Tool + Confidence + Period + Currency */}
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                      <BarChart3 size={10} />
                      {m.tool}
                    </span>
                    {m.confidence && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${getConfidenceColor(m.confidence)}`}>
                        {m.confidence}
                      </span>
                    )}
                    {m.period && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
                        <Clock size={9} />
                        {m.period.from} to {m.period.to}
                      </span>
                    )}
                    {m.currency && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">
                        {m.currency}
                      </span>
                    )}
                  </div>

                  {/* Source reference */}
                  {m.source_rows_or_report && (
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-1">
                      Source: {m.source_rows_or_report}
                    </p>
                  )}

                  {/* Filters (Spec 9.10) */}
                  {m.filters && m.filters.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 mb-1.5">
                      <Filter size={9} className="text-gray-400" />
                      {m.filters.map((f, fi) => (
                        <span key={fi} className="text-[10px] text-gray-400 dark:text-gray-500">
                          {f.field}: {String(f.value || 'all')}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Warnings */}
                  {m.warnings && m.warnings.length > 0 && (
                    <div className="flex items-start gap-1 mt-1.5">
                      <AlertTriangle size={10} className="text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        {m.warnings.map((w, wi) => (
                          <p key={wi} className="text-[10px] text-amber-600 dark:text-amber-400">{w}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Data-as-of timestamp */}
                  {m.data_as_of && (
                    <p className="text-[9px] text-gray-300 dark:text-gray-600 mt-1">
                      Data as of: {new Date(m.data_as_of).toLocaleString()}
                    </p>
                  )}

                  {/* Suggested safe actions (Spec 9.10) — clickable to pre-fill input */}
                  {m.suggested_safe_actions && m.suggested_safe_actions.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {m.suggested_safe_actions.map((action, ai) => (
                        <button
                          key={ai}
                          onClick={() => setInput(action)}
                          className="block w-full text-left text-[10px] px-2 py-1 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ─── Feedback buttons (Spec 9.9 ai_feedback) ─── */}
              {m.role === 'assistant' && i > 0 && (
                <div className="flex items-center gap-1 mt-2">
                  <button
                    onClick={() => submitFeedback(i, 'up')}
                    className={`p-1 rounded transition-colors ${
                      m.feedbackGiven === 'up'
                        ? 'text-green-500 bg-green-50 dark:bg-green-900/20'
                        : 'text-gray-300 dark:text-gray-600 hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'
                    }`}
                    title="Helpful"
                  >
                    <ThumbsUp size={12} />
                  </button>
                  <button
                    onClick={() => submitFeedback(i, 'down')}
                    className={`p-1 rounded transition-colors ${
                      m.feedbackGiven === 'down'
                        ? 'text-red-500 bg-red-50 dark:bg-red-900/20'
                        : 'text-gray-300 dark:text-gray-600 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    }`}
                    title="Not helpful"
                  >
                    <ThumbsDown size={12} />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 p-3 rounded-lg text-sm">
              <div className="flex items-center gap-2">
                <div className="flex space-x-1">
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                </div>
                <span className="text-xs">Querying authorized reports...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ─── Input Area ─── */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          placeholder={hasAiAccess ? 'Ask about your finance data...' : 'No AI access for your role'}
          className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
          disabled={isLoading || !hasAiAccess}
        />
        <button
          type="submit"
          className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          disabled={isLoading || !hasAiAccess}
        >
          <Send size={14} />
          <span className="hidden sm:inline">Send</span>
        </button>
      </form>
    </div>
  );
}

// ─── Suggestion Chip Component ───
function SuggestionChip({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 dark:hover:bg-indigo-900/20 dark:hover:text-indigo-400 dark:hover:border-indigo-800 transition-all"
    >
      {text}
    </button>
  );
}