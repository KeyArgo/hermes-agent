import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '@/components/error-boundary'
import { createPluginContext } from '@/contrib/plugin'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'

import { BackdropLayer } from './backdrop-layer'

// The boundary key is the reconciliation seam: it alone decides whether a
// re-registration resets the backdrop's error state. Capture the key React
// actually reconciles with so the test can pin it to the registration's
// identity (source:id + a registration counter), not to a render-phase
// counter, which is impure and local to one component instance.
const boundaryKeys: Array<string | number | null> = []

vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const jsxDEV = actual.jsxDEV as (type: unknown, props: unknown, key?: unknown, ...rest: unknown[]) => unknown

  return {
    ...actual,
    jsxDEV: (type: unknown, props: Record<string, unknown>, key?: unknown, ...rest: unknown[]) => {
      if (type === ErrorBoundary) {
        boundaryKeys.push((key ?? props.key ?? null) as string | number | null)
      }

      return jsxDEV(type, props, key, ...rest)
    }
  }
})

const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-key')

// Off by default now; this file is about a mounted backdrop's error boundary.
beforeEach(() => {
  setPluginBackdropsEnabled(true)
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  boundaryKeys.length = 0
  vi.restoreAllMocks()
})

describe('BackdropLayer error-boundary key', () => {
  it('keys the boundary by registration identity, stable across unrelated renders', () => {
    const mounts = vi.fn()

    function Scene() {
      useEffect(() => {
        mounts()
      }, [])

      return <div>scene</div>
    }

    const { rerender } = render(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: Scene }))
    })

    const firstKey = boundaryKeys.at(-1)
    const mounted = mounts.mock.calls.length

    // Identity, not render order: the key carries the contribution's
    // namespaced id, so it is a pure function of the registration.
    expect(String(firstKey)).toContain('backdrop-key:bg')
    expect(mounted).toBeGreaterThan(0)

    // Unrelated host re-renders keep the registration — and its boundary.
    rerender(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )
    expect(boundaryKeys.at(-1)).toBe(firstKey)
    expect(mounts.mock.calls.length).toBe(mounted)

    // Re-registering the same id is a NEW registration: a new key, so the
    // boundary (and any error state it holds) is reset.
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: Scene }))
    })
    expect(boundaryKeys.at(-1)).not.toBe(firstKey)
    expect(String(boundaryKeys.at(-1))).toContain('backdrop-key:bg')
    expect(mounts.mock.calls.length).toBeGreaterThan(mounted)
  })

  it('resets a failed backdrop when the same id is re-registered', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'bg',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(screen.queryByText('fixed')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: () => <div>fixed</div> }))
    })
    expect(screen.getByText('fixed')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })
})
