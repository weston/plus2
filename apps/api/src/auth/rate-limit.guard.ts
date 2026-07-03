import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/**
 * Lightweight in-memory, per-IP sliding-window rate limiter for the auth
 * endpoints (login/register/refresh). The API runs as a single instance, so an
 * in-process map is enough — no external store or new dependency. Keyed by
 * route + client IP: ~10 requests / minute.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly windowMs = 60_000;
  private readonly maxRequests = 10;
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const key = `${this.routeKey(req)}:${this.clientIp(req)}`;
    const now = Date.now();

    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      throw new HttpException(
        'Too many requests — please slow down and try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.sweep(now);
    return true;
  }

  private routeKey(req: any): string {
    return req.route?.path ?? req.originalUrl ?? req.url ?? '';
  }

  private clientIp(req: any): string {
    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  // Periodically drop empty/expired buckets so the map stays bounded.
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, ts] of this.hits) {
      const live = ts.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.hits.delete(k);
      else this.hits.set(k, live);
    }
  }
}
