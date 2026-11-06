/**
 * Owner authentication middleware. Expects `Authorization: Arena <wallet>:<issuedAtMs>:<sig>`
 * where sig is the wallet's EIP-191 signature of authMessage(wallet, issuedAtMs). Smart-contract
 * wallets work too (publicClient.verifyMessage handles ERC-1271 / ERC-6492).
 */
import { AUTH_MAX_AGE_MS, authMessage } from '@starter/shared/auth'
import type { NextFunction, Request, Response } from 'express'
import { getAddress, isAddress, isHex, type Address, type PublicClient } from 'viem'
import { HttpError } from '../http'

export function ownerAuth(publicClient: PublicClient, now: () => number = Date.now) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? ''
      const match = /^Arena (0x[0-9a-fA-F]{40}):(\d{13}):(0x[0-9a-fA-F]+)$/.exec(header)
      if (!match) throw new HttpError(401, 'auth_required')
      const [, walletRaw, issuedRaw, signature] = match
      if (!isAddress(walletRaw!) || !isHex(signature)) throw new HttpError(401, 'auth_invalid')
      const issuedAt = Number(issuedRaw)
      const age = now() - issuedAt
      if (age < -60_000 || age > AUTH_MAX_AGE_MS) throw new HttpError(401, 'auth_expired')
      const wallet = getAddress(walletRaw!)
      const valid = await publicClient.verifyMessage({
        address: wallet,
        message: authMessage(wallet, issuedAt),
        signature: signature as `0x${string}`,
      })
      if (!valid) throw new HttpError(401, 'auth_invalid')
      res.locals.wallet = wallet
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** The wallet ownerAuth verified for this request. */
export function walletOf(res: Response): Address {
  const wallet = res.locals.wallet as Address | undefined
  if (!wallet) throw new HttpError(401, 'auth_required')
  return wallet
}
