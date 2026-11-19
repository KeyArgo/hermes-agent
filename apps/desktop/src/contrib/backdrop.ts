import type { Contribution } from './types'

let sequence = 0
const registrations = new WeakMap<Contribution, number>()

export function recordBackdropRegistration(contribution: Contribution): void {
  registrations.set(contribution, ++sequence)
}

/** The registration's sequence number — the counter behind the backdrop
 *  layer's ErrorBoundary key, kept outside render. Unrecorded entries (a raw
 *  registry registration) sort at 0, the same floor `latestBackdrop` uses. */
export function backdropRegistrationSeq(contribution: Contribution): number {
  return registrations.get(contribution) ?? 0
}

export function latestBackdrop(items: readonly Contribution[]): Contribution | undefined {
  let latest: Contribution | undefined
  let latestSequence = -1

  for (const item of items) {
    const registered = registrations.get(item) ?? 0

    if (item.render && registered > latestSequence) {
      latest = item
      latestSequence = registered
    }
  }

  return latest
}
