// The inline message-edit composer is a pinned box over the transcript: the
// messages it covers scroll behind it. Window glass keeps its raised mix, and a
// plugin backdrop clears `--ui-chat-surface-background` on <html>, so the box
// additionally opts into the opaque fill under a backdrop only.
import { AssistantRuntimeProvider, ExportedMessageRepository, type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'

import { assistantMessage, stubThreadEnvironment, stubThreadViewportSize, userMessage } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const SESSION = 'sess-edit-backdrop'

const gateway = {
  request: async () => ({ categories: [], pairs: [] })
} as unknown as HermesGateway

function Harness() {
  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: ExportedMessageRepository.fromArray([userMessage(), assistantMessage()]),
    isRunning: false,
    setMessages: () => {},
    onNew: async () => {},
    onEdit: async () => {},
    onCancel: async () => {},
    onReload: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread gateway={gateway} sessionId={SESSION} />
    </AssistantRuntimeProvider>
  )
}

afterEach(() => {
  cleanup()
  window.document.documentElement.removeAttribute('data-hermes-plugin-backdrop')
})

describe('inline edit composer under a plugin backdrop', () => {
  it('keeps the raised box for glass and adds the backdrop-only fill', async () => {
    window.document.documentElement.setAttribute('data-hermes-plugin-backdrop', '')
    const { container } = render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))
    const editor = await screen.findByRole('textbox', { name: 'Edit message' })
    const root = container.querySelector('[data-slot="aui_edit-composer-root"]')
    // The nearest painted ancestor of the editor is the composer box itself: it
    // keeps the raised mix window glass has always used, and declares the
    // backdrop-only opaque fill so the scene stays out of the text.
    const box = editor.closest('[data-backdrop-opaque]')

    expect(root).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box?.className).toContain('composer-human-message-container')
    expect(box?.hasAttribute('data-glass-raised')).toBe(true)
    expect(box?.hasAttribute('data-glass-opaque')).toBe(false)
    expect(root?.contains(box)).toBe(true)
  })
})
