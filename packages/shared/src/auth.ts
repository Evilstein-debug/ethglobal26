/**
 * Owner authentication: the owner signs this exact message (EIP-191) with their wallet and sends
 * `Authorization: Arena <wallet>:<issuedAtMs>:<signature>`. The server verifies the signature
 * (EOA or smart wallet) and that it was issued within AUTH_MAX_AGE_MS.
 */
export const AUTH_MAX_AGE_MS = 10 * 60 * 1000

export function authMessage(wallet: string, issuedAtMs: number): string {
  return [
    'AgentArena: sign in',
    `Wallet: ${wallet.toLowerCase()}`,
    `Issued: ${new Date(issuedAtMs).toISOString()}`,
    'This signature only proves you control this wallet. It costs nothing and moves no funds.',
  ].join('\n')
}

export function authHeader(wallet: string, issuedAtMs: number, signature: string): string {
  return `Arena ${wallet.toLowerCase()}:${issuedAtMs}:${signature}`
}
