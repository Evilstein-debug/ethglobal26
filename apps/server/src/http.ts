import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodError } from 'zod'
import { EgressDenied } from './wallets/signer'

/** An error the API returns as `{ error: code, detail? }` with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code)
  }
}

/** Wrap an async handler so rejections reach the error middleware. */
export const handler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next)
  }

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, ...(err.detail ? { detail: err.detail } : {}) })
    return
  }
  if (err instanceof EgressDenied) {
    res.status(409).json({ error: 'signer_refused', reason: err.reason })
    return
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'invalid_request',
      detail: err.issues.map((i) => ({ path: i.path, message: i.message })),
    })
    return
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json' })
    return
  }
  console.error(`[server] ${req.method} ${req.path} failed:`, err)
  res.status(500).json({ error: 'internal_error' })
}
