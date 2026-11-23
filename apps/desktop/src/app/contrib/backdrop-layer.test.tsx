import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPluginContext } from '@/contrib/plugin'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'
import * as windows from '@/store/windows'

import { BackdropLayer } from './backdrop-layer'

const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-test')

// The setting is off on a fresh store; these tests exercise a live backdrop, so
// they opt in. The off-by-default path has its own file (backdrop-layer-off).
beforeEach(() => {
  setPluginBackdropsEnabled(true)
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setPluginBackdropsEnabled(true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('BackdropLayer', () => {
  it('selects a re-registered contribution and falls back when it is disposed', () => {
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'a', order: -100, render: () => <div>first A</div> }))
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'b', order: 100, render: () => <div>B</div> }))
    })
    expect(screen.getByText('B')).toBeTruthy()
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'a', order: -100, render: () => <div>new A</div> }))
    })
    expect(screen.getByText('new A')).toBeTruthy()
    expect(screen.queryByText('B')).toBeNull()
    act(() => disposers.pop()?.())
    expect(screen.getByText('B')).toBeTruthy()
  })

  it('mounts a real backdrop in a contained, click-through wrapper and restores the host on disposal', () => {
    vi.spyOn(windows, 'isMainWindow').mockReturnValue(true)
    const { container } = render(<BackdropLayer />)
    const bodyChildren = [...document.body.children]

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'first',
          order: 100,
          render: () => <div>first</div>
        })
      )
    })
    // A real contribution, inside the host's own wrapper — not a portal.
    const layer = container.querySelector('[data-plugin-backdrop]') as HTMLElement
    expect(screen.getByText('first')).toBeTruthy()
    expect(layer.style.position).toBe('fixed')
    expect(layer.style.pointerEvents).toBe('none')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.hasAttribute('inert')).toBe(true)
    expect([...document.body.children]).toEqual(bodyChildren)
    // The wrapper only exists because this is the main window.
    expect(windows.isMainWindow).toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'second', order: -100, render: () => <div>second</div> }))
    })
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeTruthy()
    act(() => disposers.pop()?.())
    expect(screen.getByText('first')).toBeTruthy()
    act(() => disposers.pop()?.())
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('')
  })

  it('clamps the backdrop and surface opacity', () => {
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'clamped',
          data: { opacity: 2, dimApp: -1 },
          render: () => <div>scene</div>
        })
      )
    })
    expect((container.querySelector('[data-plugin-backdrop]') as HTMLElement).style.opacity).toBe('1')
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('70%')
  })

  it('floors the app dim at 70% so chat text stays readable over a bright backdrop', () => {
    render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'washed',
          data: { dimApp: 0.35 },
          render: () => <div>bright scene</div>
        })
      )
    })
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('70%')
  })

  it('restores a valid backdrop when the Appearance setting is toggled off and back on', () => {
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()

    act(() => setPluginBackdropsEnabled(false))
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(screen.queryByText('scene')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    act(() => setPluginBackdropsEnabled(true))
    expect(screen.getByText('scene')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('75%')
  })

  it('keeps a backdrop transparent when the browser ignores the reduced-transparency query', () => {
    // An engine that predates the feature: matchMedia resolves, nothing matches.
    // The root attribute is the CSS gate's only input, so the surface rules must
    // still apply — the media query can never be the second source of truth.
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('keeps a backdrop transparent when matchMedia is missing entirely', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })
    expect(screen.getByText('scene')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })

  it('honors the setting and contains a failing contribution', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setPluginBackdropsEnabled(false)
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'broken',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    act(() => setPluginBackdropsEnabled(true))
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
  })

  it.each(['?win=secondary', '?win=hud', '?win=browser', '?watch=1', '?peer=1'])(
    'does not mount in %s',
    async search => {
      window.history.replaceState({}, '', `/${search}`)
      vi.resetModules()
      const freshWindows = await import('@/store/windows')
      vi.spyOn(windows, 'isMainWindow').mockReturnValue(freshWindows.isMainWindow())
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'window', render: () => <div>scene</div> }))
      render(<BackdropLayer />)
      expect(screen.queryByText('scene')).toBeNull()
      expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    }
  )

  it('unmounts when reduced transparency changes and restores on reversal', () => {
    let reduced = false
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reduced
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
    }))
    const unmount = vi.fn()

    function Scene() {
      useEffect(() => unmount, [])

      return <div>scene</div>
    }

    disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'reduced', render: Scene }))
    render(<BackdropLayer />)
    expect(screen.getByText('scene')).toBeTruthy()
    act(() => {
      reduced = true
      listeners.forEach(listener => listener())
    })
    expect(screen.queryByText('scene')).toBeNull()
    expect(unmount).toHaveBeenCalledOnce()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    act(() => {
      reduced = false
      listeners.forEach(listener => listener())
    })
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('unmounts when reduced motion changes and restores on reversal', () => {
    let motion = false
    const listeners = new Map<string, Set<() => void>>()
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === '(prefers-reduced-motion: reduce)' ? motion : false
      },
      addEventListener: (_: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set()
        set.add(listener)
        listeners.set(query, set)
      },
      removeEventListener: (_: string, listener: () => void) => {
        listeners.get(query)?.delete(listener)
      }
    }))
    const unmount = vi.fn()

    function Scene() {
      useEffect(() => unmount, [])

      return <div>scene</div>
    }

    disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'motion', render: Scene }))
    render(<BackdropLayer />)
    expect(screen.getByText('scene')).toBeTruthy()
    act(() => {
      motion = true
      listeners.get('(prefers-reduced-motion: reduce)')?.forEach(listener => listener())
    })
    expect(screen.queryByText('scene')).toBeNull()
    expect(unmount).toHaveBeenCalledOnce()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    act(() => {
      motion = false
      listeners.get('(prefers-reduced-motion: reduce)')?.forEach(listener => listener())
    })
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('type-checks a backdrop contribution at the call site', () => {
    // Never invoked: the body is a `tsc` assertion, proven by the directives
    // below turning into "unused @ts-expect-error" errors if the typing widens.
    const backdropCallSite = () => {
      // @ts-expect-error a backdrop's `data` is the closed { opacity?, dimApp? } payload.
      ctx.register({ area: BACKDROP_AREA, id: 'bad-data', data: { bloom: 1 }, render: () => null })
      // @ts-expect-error a backdrop must provide `render`.
      ctx.register({ area: BACKDROP_AREA, id: 'no-render' })
    }

    expect(backdropCallSite).toBeTypeOf('function')
  })

  it('skips entries without render and recovers when the same id is replaced', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'valid', render: () => <div>valid</div> }))
    })
    act(() => {
      // A render-less backdrop can only arrive from an untyped/JS plugin (the
      // typed `register` requires `render`); the host still skips it.
      disposers.push(ctx.registerMany([{ area: BACKDROP_AREA, id: 'missing' }]))
    })
    expect(screen.getByText('valid')).toBeTruthy()
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'broken',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(screen.queryByText('valid')).toBeNull()
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'broken', render: () => <div>fixed</div> }))
    })
    expect(screen.getByText('fixed')).toBeTruthy()
  })

  it('cleans up after a child effect throws and falls back for non-finite values', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    function Broken() {
      useEffect(() => {
        throw new Error('effect')
      }, [])

      return null
    }

    // The app lives beside the layer: containment means a throwing scene takes
    // only the backdrop down. React reports commit-phase (effect) errors the
    // same way it reports render errors — through the nearest boundary's
    // getDerivedStateFromError — so the subtree unmounts, its layout-effect
    // cleanup strips the <html> attributes, and the fallback renders null.
    const { container } = render(
      <>
        <div>app</div>
        <BackdropLayer />
      </>
    )

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'nan',
          data: { opacity: NaN, dimApp: NaN },
          render: () => <div>scene</div>
        })
      )
    })
    expect((container.querySelector('[data-plugin-backdrop]') as HTMLElement).style.opacity).toBe('1')
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('75%')
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'effect', render: Broken }))
    })
    expect(screen.getByText('app')).toBeTruthy()
    expect(screen.queryByText('scene')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('')
  })
})
