import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200, // Personal server — higher limit to accommodate polling, pulses, and active browsing
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  skip: (req) => {
    // Exempt internal/localhost and local network (home WiFi)
    const ip = req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
      || ip.startsWith('192.168.') || ip.startsWith('::ffff:192.168.')
      || ip.startsWith('10.') || ip.startsWith('::ffff:10.');
  },
});

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  validate: { trustProxy: false },
});

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=()');
  next();
}
