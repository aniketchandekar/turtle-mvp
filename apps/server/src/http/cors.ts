import type { Request, Response, NextFunction } from 'express';

/**
 * Minimal permissive CORS for local dev (client on :3000, server on :8787).
 * Tighten to an allowlist before any non-local deployment.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
