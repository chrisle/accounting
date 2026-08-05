'use client'

import { useEffect, useState } from 'react'

type Mode = 'light' | 'dark' | 'system'

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('system')

  useEffect(() => {
    setMode((localStorage.getItem('theme') as Mode) ?? 'system')
  }, [])

  const apply = (m: Mode) => {
    setMode(m)
    if (m === 'system') {
      delete document.documentElement.dataset.theme
      localStorage.removeItem('theme')
    } else {
      document.documentElement.dataset.theme = m
      localStorage.setItem('theme', m)
    }
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
      {(['light', 'system', 'dark'] as const).map((m) => (
        <button
          key={m}
          onClick={() => apply(m)}
          aria-pressed={mode === m}
          title={`${m} theme`}
          className={`rounded px-2 py-1 text-xs capitalize transition-colors ${
            mode === m ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {m === 'light' ? '☀' : m === 'dark' ? '☾' : 'Auto'}
        </button>
      ))}
    </div>
  )
}
