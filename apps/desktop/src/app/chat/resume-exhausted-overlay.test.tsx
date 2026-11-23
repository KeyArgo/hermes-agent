// Stranded resume overlay (#106217 remainder): the full-window
// "Couldn't load this session" state hides the composer and used to offer
// only Retry — a wall with no way out. It must offer Start new session
// (the existing fresh-draft path) next to Retry. No lease/takeover touch:
// this only navigates away from the stranded route.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const requestFreshSession = vi.hoisted(() => vi.fn())

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestFreshSession: () => requestFreshSession()
}))

import { ResumeExhaustedOverlay } from './resume-exhausted-overlay'

afterEach(() => {
  cleanup()
  requestFreshSession.mockClear()
})

describe('stranded resume overlay escape (#106217)', () => {
  it('offers Start new session next to Retry instead of a retry-only dead end', async () => {
    const onRetryResume = vi.fn()

    render(<ResumeExhaustedOverlay onRetryResume={onRetryResume} sessionId="session-1" />)

    expect(await screen.findByRole('button', { name: 'Start new session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()

    screen.getByRole('button', { name: 'Start new session' }).click()
    expect(requestFreshSession).toHaveBeenCalledTimes(1)
    expect(onRetryResume).not.toHaveBeenCalled()
  })

  it('keeps Retry resuming the stranded session', async () => {
    const onRetryResume = vi.fn()

    render(<ResumeExhaustedOverlay onRetryResume={onRetryResume} sessionId="session-1" />)

    screen.getByRole('button', { name: 'Retry' }).click()
    expect(onRetryResume).toHaveBeenCalledWith('session-1')
    expect(requestFreshSession).not.toHaveBeenCalled()
  })

  it('stays solid over the thread under a plugin backdrop', () => {
    const { container } = render(<ResumeExhaustedOverlay onRetryResume={vi.fn()} sessionId="session-1" />)

    // The overlay masks the thread, and a backdrop clears the chat surface
    // token — so it opts into the opaque fill for backdrops only.
    const overlay = container.firstElementChild

    expect(overlay?.hasAttribute('data-backdrop-opaque')).toBe(true)
    // Window glass on its own is untouched.
    expect(overlay?.hasAttribute('data-glass-opaque')).toBe(false)
  })
})
