'use client';

import React from 'react';

interface DiffViewerProps {
  diff: string;
  emptyLabel?: string;
}

export function DiffViewer({ diff, emptyLabel = 'No diff available.' }: DiffViewerProps) {
  if (!diff || !diff.trim()) {
    return <div className="text-zinc-500 p-3 font-mono text-xs">{emptyLabel}</div>;
  }

  const lines = diff.split('\n');

  return (
    <div className="font-mono text-xs leading-relaxed overflow-x-auto select-text">
      {lines.map((line, idx) => {
        if (
          line.startsWith('diff --git') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('index ')
        ) {
          return (
            <div
              key={idx}
              className="px-2.5 py-0.5 text-zinc-300 bg-zinc-900/90 font-semibold whitespace-pre"
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <div
              key={idx}
              className="px-2.5 py-0.5 text-blue-400 bg-blue-950/25 whitespace-pre"
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('+')) {
          return (
            <div
              key={idx}
              className="px-2.5 py-0.5 text-emerald-300 bg-emerald-500/15 whitespace-pre"
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('-')) {
          return (
            <div
              key={idx}
              className="px-2.5 py-0.5 text-rose-300 bg-rose-500/15 whitespace-pre"
            >
              {line}
            </div>
          );
        }
        return (
          <div key={idx} className="px-2.5 py-0.5 text-zinc-400 whitespace-pre">
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
