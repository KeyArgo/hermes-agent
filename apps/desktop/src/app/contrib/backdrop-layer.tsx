import { useStore } from '@nanostores/react'
import { type CSSProperties, type ReactNode, useLayoutEffect } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'
import { $backdropSequence, latestBackdrop, type PluginBackdropData } from '@/contrib/backdrop'
import { ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { useMediaQuery } from '@/hooks/use-media-query'
import { BACKDROP_AREA } from '@/sdk/areas'
import { $pluginBackdropsEnabled } from '@/store/plugin-backdrops'
import { isMainWindow } from '@/store/windows'

// The shell may never thin past this, whatever a plugin asks for: secondary
// text over a moving scene is unreadable below it.
const MIN_APP_OPACITY = 85
const DEFAULT_APP_OPACITY = 0.85

// Any one of these unmounts the backdrop: the OS is asking for less motion,
// less transparency, or more contrast. Read live, so the scene returns once
// none applies.
const TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'
const MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const FORCED_COLORS_QUERY = '(forced-colors: active)'
const CONTRAST_QUERY = '(prefers-contrast: more)'

function clamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function BackdropContent({ data, render }: { data: unknown; render: () => ReactNode }) {
  const payload = data as PluginBackdropData | undefined
  const appOpacity = Math.max(MIN_APP_OPACITY, clamp(payload?.appOpacity, DEFAULT_APP_OPACITY) * 100)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-hermes-plugin-backdrop', '')
    root.style.setProperty('--plugin-backdrop-dim', `${appOpacity}%`)

    return () => {
      root.removeAttribute('data-hermes-plugin-backdrop')
      root.style.removeProperty('--plugin-backdrop-dim')
    }
  }, [appOpacity])

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
          opacity: clamp(payload?.opacity, 1)
        } as CSSProperties
      }
    >
      <ContribRender render={render} />
    </div>
  )
}

/** `useContributions` runs the area's `when()` predicates, so it lives inside
 *  the boundary with the render: a throwing predicate blanks the layer alone. */
function BackdropScene() {
  const contribution = latestBackdrop(useContributions(BACKDROP_AREA))
  const render = contribution?.render

  if (!contribution || typeof render !== 'function') {
    return null
  }

  return <BackdropContent data={contribution.data} render={render} />
}

function BackdropBoundary() {
  // Keyed by the registration counter: the boundary (and any error it holds)
  // belongs to one registration, and the next one replaces it.
  const sequence = useStore($backdropSequence)

  return (
    <ErrorBoundary fallback={() => null} key={sequence} label="contrib:backdrop">
      <BackdropScene />
    </ErrorBoundary>
  )
}

export function BackdropLayer() {
  const enabled = useStore($pluginBackdropsEnabled)
  const reducedTransparency = useMediaQuery(TRANSPARENCY_QUERY)
  const reducedMotion = useMediaQuery(MOTION_QUERY)
  const forcedColors = useMediaQuery(FORCED_COLORS_QUERY)
  const moreContrast = useMediaQuery(CONTRAST_QUERY)

  // Nothing backdrop-related — subscription included — runs unless the layer
  // could actually paint.
  if (!enabled || reducedTransparency || reducedMotion || forcedColors || moreContrast || !isMainWindow()) {
    return null
  }

  return <BackdropBoundary />
}
