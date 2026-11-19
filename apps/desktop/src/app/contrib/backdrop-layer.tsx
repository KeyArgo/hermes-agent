import { useStore } from '@nanostores/react'
import { type CSSProperties, useLayoutEffect, useSyncExternalStore } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'
import { backdropRegistrationSeq, latestBackdrop } from '@/contrib/backdrop'
import { useContributions } from '@/contrib/react/use-contributions'
import type { Contribution } from '@/contrib/types'
import { useMediaQuery } from '@/hooks/use-media-query'
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

// The OS accessibility signals, re-read live: reduced transparency or reduced
// motion unmounts the backdrop entirely (see BackdropLayer). A browser that
// doesn't know a feature reports `matches: false`, i.e. "allowed" — which is
// why the CSS side keys its surface rules off the attribute this layer sets,
// never off the media query.
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
  const dim = Math.max(70, clamp(data?.dimApp, 0.75) * 100)

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
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const contribution = latestBackdrop(items)

  if (!enabled || reduced || reducedMotion || !isMainWindow() || !contribution?.render) {
    return null
  }

  return (
    <ErrorBoundary
      fallback={() => null}
      // Registration identity, counted outside render: re-registering the same
      // id is a new contribution with a new sequence number, so the boundary
      // remounts and an error cannot outlive the registration it belonged to.
      key={`${contribution.source ?? 'core'}:${contribution.id}:${backdropRegistrationSeq(contribution)}`}
      label={`contrib:${contribution.id}`}
    >
      <BackdropContent contribution={contribution} />
    </ErrorBoundary>
  )
}
