'use client'

import { useEffect, useState } from 'react'

/**
 * Series colours are chosen per mode (see projects.color / color_dark), not
 * derived by flipping lightness, so the chart needs to know which mode is live.
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const read = () => {
      const stamped = document.documentElement.dataset.theme
      if (stamped === 'dark') return true
      if (stamped === 'light') return false
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    setDark(read())

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMq = () => setDark(read())
    mq.addEventListener('change', onMq)

    const obs = new MutationObserver(() => setDark(read()))
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      mq.removeEventListener('change', onMq)
      obs.disconnect()
    }
  }, [])

  return dark
}

export type SeriesMeta = {
  id: string
  name: string
  color: string
  colorDark: string
  synthetic?: boolean
}

export const pickColor = (s: SeriesMeta, dark: boolean) =>
  dark ? s.colorDark : s.color

export const money = (n: number, compact = false) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: compact ? 0 : 2,
    notation: compact && Math.abs(n) >= 10_000 ? 'compact' : 'standard',
  })
