/**
 * RecommendationChatPanel — local Claude Code analyst widget.
 *
 * The browser talks only to the local tokenomix server. Claude Code provider
 * settings stay behind the backend route.
 */

import { useQuery } from '@tanstack/react-query';
import type { RecommendationChatMessage } from '@tokenomix/shared';
import { AlertCircle, Bot, Loader2, Send, Sparkles, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchRecommendationChatStatus, streamRecommendationChat } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

function statusLabel(available: boolean | undefined): string {
  if (available === true) return 'Claude Code ready';
  if (available === false) return 'Claude Code unavailable';
  return 'Checking Claude Code';
}

type LocalChatMessage = RecommendationChatMessage & {
  id: string;
  costUsd?: number | null;
  durationMs?: number | null;
  warning?: string | null;
};

function makeMessage(
  role: RecommendationChatMessage['role'],
  content: string,
  metadata: Pick<LocalChatMessage, 'costUsd' | 'durationMs' | 'warning'> = {}
): LocalChatMessage {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    role,
    content,
    ...metadata,
  };
}

const markdownPlugins = [remarkGfm];

const markdownComponents: Components = {
  h1({ node: _node, ...props }) {
    return <h3 className="mb-2 text-base font-semibold leading-6 text-gray-100" {...props} />;
  },
  h2({ node: _node, ...props }) {
    return <h3 className="mb-2 text-base font-semibold leading-6 text-gray-100" {...props} />;
  },
  h3({ node: _node, ...props }) {
    return <h3 className="mb-2 text-sm font-semibold leading-6 text-gray-100" {...props} />;
  },
  p({ node: _node, ...props }) {
    return <p className="mb-3 last:mb-0" {...props} />;
  },
  strong({ node: _node, ...props }) {
    return <strong className="font-semibold text-gray-100" {...props} />;
  },
  code({ node: _node, className, ...props }) {
    return (
      <code
        className={cx(
          'rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-gray-100',
          className
        )}
        {...props}
      />
    );
  },
  pre({ node: _node, ...props }) {
    return (
      <pre
        className="mb-3 overflow-x-auto rounded-lg border border-black/60 bg-black/40 p-3 text-xs leading-5"
        {...props}
      />
    );
  },
  ul({ node: _node, ...props }) {
    return <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0" {...props} />;
  },
  ol({ node: _node, ...props }) {
    return <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0" {...props} />;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="mb-3 overflow-x-auto rounded-lg border border-black/60 last:mb-0">
        <table className="min-w-full border-collapse text-left text-xs" {...props} />
      </div>
    );
  },
  th({ node: _node, ...props }) {
    return (
      <th
        className="border-b border-black/60 bg-black/30 px-2 py-1.5 font-semibold text-gray-100"
        {...props}
      />
    );
  },
  td({ node: _node, ...props }) {
    return <td className="border-b border-black/40 px-2 py-1.5 last:border-b-0" {...props} />;
  },
  a({ node: _node, ...props }) {
    return (
      <a
        className="text-primary-light underline decoration-primary-light/40 underline-offset-2 hover:decoration-primary-light"
        target="_blank"
        rel="noreferrer"
        {...props}
      />
    );
  },
};

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

export function RecommendationChatPanel() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.recommendationChatStatus(),
    queryFn: fetchRecommendationChatStatus,
    staleTime: 60_000,
    retry: 1,
  });

  const canSubmit = useMemo(() => {
    return draft.trim().length > 0 && statusQuery.data?.available === true && !isSending;
  }, [draft, statusQuery.data?.available, isSending]);
  const hasDraft = draft.trim().length > 0;
  const scrollSignal = messages.map((message) => message.content.length).join(':');

  useEffect(() => {
    void scrollSignal;
    const list = messageListRef.current;
    if (!list || !isOpen) return;
    list.scrollTop = list.scrollHeight;
  }, [scrollSignal, isOpen]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !canSubmit) return;

    const assistantId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setMessages((current) => [
      ...current,
      makeMessage('user', message),
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setDraft('');
    setIsSending(true);

    void streamRecommendationChat(
      { message },
      {
        onDelta: (text) => {
          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantId ? { ...entry, content: entry.content + text } : entry
            )
          );
        },
        onDone: (response) => {
          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantId
                ? {
                    ...entry,
                    content: response.answer || entry.content,
                    costUsd: response.costUsd,
                    durationMs: response.durationMs,
                    warning: response.warning,
                  }
                : entry
            )
          );
          setIsSending(false);
        },
        onError: (error) => {
          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantId
                ? { ...entry, content: error || 'Claude Code request failed.' }
                : entry
            )
          );
          setIsSending(false);
        },
      }
    ).catch((error) => {
      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantId
            ? {
                ...entry,
                content: error instanceof Error ? error.message : 'Claude Code request failed.',
              }
            : entry
        )
      );
      setIsSending(false);
    });
  }

  return (
    <div className="fixed bottom-6 right-6 z-[70] flex flex-col items-end gap-3">
      {isOpen && (
        <section
          className="w-[calc(100vw-2rem)] max-w-[440px] overflow-hidden rounded-2xl border border-black/80 bg-gray-900/50 shadow-2xl backdrop-blur-sm dark"
          aria-label="Recommendation chat"
        >
          <div className="px-4 py-3 border-b border-black/80">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Bot size={16} aria-hidden="true" className="text-gray-500 dark:text-gray-400" />
                <h2 className="truncate text-sm font-semibold text-white">Assistant</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-black/80 bg-black/30 px-2 py-0.5 text-xs font-medium text-primary-light">
                  {statusQuery.isLoading ? 'Checking' : statusLabel(statusQuery.data?.available)}
                </span>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close AI chat"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <div className="px-4 py-3 space-y-3">
            {statusQuery.data?.available === false && (
              <div className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950 px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
                <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>
                  {statusQuery.data.message ?? 'Claude Code is not available in this process.'}
                </span>
              </div>
            )}

            <div
              ref={messageListRef}
              className="h-[min(420px,calc(100vh-13rem))] min-h-64 overflow-y-auto overscroll-contain rounded-lg border border-black/80 bg-black/50"
            >
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500 dark:text-gray-500">
                  Ask about your Claude Code usage, cost drivers, or optimization opportunities.
                </div>
              ) : (
                <div className="space-y-3 p-3">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cx(
                        'flex',
                        message.role === 'user' ? 'justify-end' : 'justify-start'
                      )}
                    >
                      <div
                        className={cx(
                          'max-w-[82%] px-3 py-2 text-sm leading-6',
                          message.role === 'user'
                            ? 'rounded-2xl rounded-br-md whitespace-pre-wrap bg-primary text-white dark:bg-primary-light dark:text-gray-950'
                            : 'rounded-2xl rounded-bl-md bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-200'
                        )}
                      >
                        {message.role === 'assistant' && message.content ? (
                          <AssistantMarkdown content={message.content} />
                        ) : message.role === 'assistant' ? (
                          <span className="inline-flex items-center gap-2 text-gray-500 dark:text-gray-400">
                            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                            Thinking...
                          </span>
                        ) : (
                          message.content
                        )}
                        {message.role === 'assistant' && message.warning && (
                          <div className="mt-2 rounded-md bg-amber-500/10 px-2 py-1 text-xs leading-5 text-amber-700 dark:text-amber-300">
                            {message.warning}
                          </div>
                        )}
                        {message.role === 'assistant' &&
                          (message.costUsd !== null || message.durationMs !== null) && (
                            <div className="mt-2 border-t border-gray-200 dark:border-gray-800 pt-1 text-xs leading-5 text-gray-500 dark:text-gray-500">
                              {message.costUsd !== null && message.costUsd !== undefined
                                ? `$${message.costUsd.toFixed(4)}`
                                : 'Cost unavailable'}
                              {message.durationMs !== null && message.durationMs !== undefined
                                ? ` · ${(message.durationMs / 1000).toFixed(1)}s`
                                : ''}
                            </div>
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form onSubmit={submit} className="flex items-center gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={2_000}
                rows={2}
                placeholder="Ask something about your usage..."
                aria-label="Message recommendations analyst"
                className="min-h-14 flex-1 resize-none rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-500 dark:placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="submit"
                disabled={!canSubmit}
                aria-label="Send message"
                className={cx(
                  'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light',
                  canSubmit
                    ? 'text-white hover:text-primary-light'
                    : hasDraft || isSending
                      ? 'text-white'
                      : 'cursor-not-allowed text-gray-600'
                )}
              >
                {isSending ? (
                  <Loader2 size={26} aria-hidden="true" className="animate-spin" />
                ) : (
                  <Send size={26} aria-hidden="true" />
                )}
              </button>
            </form>
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-label={isOpen ? 'Close AI chat' : 'Open AI chat'}
        className={[
          'inline-flex h-10 items-center gap-2 rounded-xl px-3',
          'border border-gray-200 dark:border-white/10 bg-white dark:bg-black/35 text-gray-700 dark:text-gray-400',
          'shadow-lg backdrop-blur-md transition-colors',
          'hover:bg-gray-50 hover:border-gray-300 hover:text-gray-900 dark:hover:bg-white/[0.06] dark:hover:border-white/20 dark:hover:text-gray-100',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-white/70 focus-visible:ring-offset-2',
        ].join(' ')}
      >
        <Sparkles size={16} aria-hidden="true" />
        <span className="text-sm font-semibold">Ask AI</span>
        {statusQuery.isFetching && (
          <Loader2 size={14} aria-hidden="true" className="animate-spin opacity-80" />
        )}
        {statusQuery.data?.available === false && (
          <span
            className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-300"
            aria-hidden="true"
          />
        )}
      </button>
    </div>
  );
}
