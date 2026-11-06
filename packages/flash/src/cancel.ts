/**
 * The exact cancel message Flash validates byte-for-byte (em dash U+2014, one \n), signed with
 * EIP-191 personal_sign by the funder wallet. Source: flash.definitive.fi/docs/cancelling-orders.md
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function cancelMessage(orderId: string): string {
  if (!UUID.test(orderId)) throw new Error(`cancelMessage: not an order UUID: ${orderId}`)
  return `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`
}

/** True only for a single-order cancel message (what agent signers are allowed to sign). */
export function isCancelMessage(message: string): boolean {
  const m = /^Definitive Flash v1 — Cancel Order\nOrder: (.+)$/.exec(message)
  return Boolean(m && UUID.test(m[1]!))
}
