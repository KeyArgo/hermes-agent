import { useStore } from '@nanostores/react'
import { type CSSProperties, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'
import { latestBackdrop } from '@/contrib/backdrop'
import { useContributions } from '@/contrib/react/use-contributions'
import type { Contribution } from '@/contrib/types'
import { BACKDROP_AREA } from '@/sdk/areas'
import { $pluginBackdropsEnabled } from '@/store/plugin-backdrops'
import { isMainWindow } from '@/store/windows'

interface BackdropData {
  dimApp?: number
  opacity?: number
}

function clamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

const transparencyQuery = '(prefers-reduced-transparency: reduce)'

function subscribeTransparency(onChange: () => void) {
  const media = window.matchMedia?.(transparencyQuery)
  media?.addEventListener('change', onChange)

  return () => media?.removeEventListener('change', onChange)
}

function reducedTransparency() {
  return window.matchMedia?.(transparencyQuery).matches ?? false
}

function BackdropContent({ contribution }: { contribution: Contribution }) {
  const data = contribution.data as BackdropData | undefined
  const Render = contribution.render!
  const dim = Math.max(55, clamp(data?.dimApp, 0.75) * 100)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-hermes-plugin-backdrop', '')
    root.style.setProperty('--plugin-backdrop-dim', `${dim}%`)

    return () => {
      root.removeAttribute('data-hermes-plugin-backdrop')
      root.style.removeProperty('--plugin-backdrop-dim')
    }
  }, [dim])

  return (
    <div
      aria-hidden="true"
      data-plugin-backdrop=""
      inert
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: -1,
          pointerEvents: 'none',
          opacity: clamp(data?.opacity, 1)
        } as CSSProperties
      }
    >
      <Render />
    </div>
  )
}

export function BackdropLayer() {
  const items = useContributions(BACKDROP_AREA)
  const enabled = useStore($pluginBackdropsEnabled)
  const reduced = useSyncExternalStore(subscribeTransparency, reducedTransparency, () => false)
  const contribution = latestBackdrop(items)
  const identity = useRef<{ contribution: Contribution | undefined; version: number }>({ contribution, version: 0 })

  if (identity.current.contribution !== contribution) {
    identity.current = { contribution, version: identity.current.version + 1 }
  }

  if (!enabled || reduced || !isMainWindow() || !contribution?.render) {
    return null
  }

  return (
    <ErrorBoundary fallback={() => null} key={identity.current.version} label={`contrib:${contribution.id}`}>
      <BackdropContent contribution={contribution} />
    </ErrorBoundary>
  )
}
