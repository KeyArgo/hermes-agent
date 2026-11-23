// The inline message-edit composer is a pinned box over the transcript: the
// messages it covers scroll behind it. Both translucent modes (window glass, a
// plugin backdrop) clear `--ui-chat-surface-background` on <html>, so the box
// has to opt into the opaque fill or the scene reaches the text being edited.
// Contract: `[data-glass-opaque]` in styles.css.
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
  document.documentElement.removeAttribute('data-hermes-plugin-backdrop')
})

describe('inline edit composer under a plugin backdrop', () => {
  it('paints an opaque box so the scene stays out of the text being edited', async () => {
    document.documentElement.setAttribute('data-hermes-plugin-backdrop', '')
    const { container } = render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))
    const editor = await screen.findByRole('textbox', { name: 'Edit message' })
    const root = container.querySelector('[data-slot="aui_edit-composer-root"]')
    // The nearest painted ancestor of the editor must be the composer box
    // itself, and it must take the opaque fill — not the raised (94%) mix the
    // scene shows through.
    const box = editor.closest('[data-glass-opaque]')

    expect(root).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box?.className).toContain('composer-human-message-container')
    expect(root?.contains(box)).toBe(true)
  })
})
