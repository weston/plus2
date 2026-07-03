import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthRateLimitGuard } from './rate-limit.guard';
import { RegisterDto, LoginDto, RefreshTokenDto } from './auth.dto';

type Provider = 'google' | 'wca';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @UseGuards(AuthRateLimitGuard)
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthRateLimitGuard)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthRateLimitGuard)
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req: { user: { id: string } }) {
    await this.authService.logout(req.user.id);
    return { message: 'Logged out successfully' };
  }

  // Short-lived token the SPA includes as `state` when linking a second provider
  // to the already-logged-in account (from settings).
  @Get('link-token')
  @UseGuards(JwtAuthGuard)
  linkToken(@Req() req: { user: { id: string } }) {
    return { token: this.authService.mintLinkToken(req.user.id) };
  }

  // ===========================================================================
  // OAuth (Google + WCA). Sign-in by default; if `state` is a valid link token,
  // the callback LINKS the provider to that account instead of signing in.
  // SETUP / env vars: see SSO_WCA_SETUP.md.
  // ===========================================================================

  private oauthConfig(provider: Provider) {
    const prefix = provider === 'google' ? 'GOOGLE' : 'WCA';
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      callbackUrl:
        process.env[`${prefix}_CALLBACK_URL`] ||
        `http://localhost:3001/api/auth/${provider}/callback`,
    };
  }

  private authorizeUrl(provider: Provider, cfg: { clientId: string; callbackUrl: string }, state?: string) {
    const base =
      provider === 'google'
        ? 'https://accounts.google.com/o/oauth2/v2/auth'
        : 'https://www.worldcubeassociation.org/oauth/authorize';
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.callbackUrl,
      response_type: 'code',
      scope: provider === 'google' ? 'openid email profile' : 'public email',
    });
    if (provider === 'google') {
      params.set('access_type', 'offline');
      params.set('prompt', 'select_account');
    }
    if (state) params.set('state', state);
    return `${base}?${params.toString()}`;
  }

  // Exchange the auth code for a normalized identity
  // { oauthId, email, emailVerified, name, wcaId }.
  private async fetchIdentity(
    provider: Provider,
    code: string,
    cfg: { clientId: string; clientSecret: string; callbackUrl: string },
  ): Promise<{
    oauthId: string;
    email: string;
    emailVerified: boolean;
    name?: string;
    wcaId?: string | null;
  }> {
    const tokenUrl =
      provider === 'google'
        ? 'https://oauth2.googleapis.com/token'
        : 'https://www.worldcubeassociation.org/oauth/token';
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.callbackUrl,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) throw new Error('No access token');

    if (provider === 'google') {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const p = (await infoRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean | string;
        name?: string;
      };
      if (!p.sub || !p.email) throw new Error('Incomplete Google profile');
      // Google returns email_verified as a boolean (occasionally the string
      // "true"); only a true value counts as verified.
      const emailVerified = p.email_verified === true || p.email_verified === 'true';
      return { oauthId: p.sub, email: p.email, emailVerified, name: p.name };
    } else {
      const meRes = await fetch('https://www.worldcubeassociation.org/api/v0/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const me = (await meRes.json()) as {
        me?: { id: number; wca_id: string | null; name?: string; email?: string };
      };
      const p = me.me;
      if (!p?.email) throw new Error('Incomplete WCA profile');
      // WCA verifies member emails, so treat the WCA-supplied email as verified.
      return {
        oauthId: String(p.id),
        email: p.email,
        emailVerified: true,
        name: p.name,
        wcaId: p.wca_id,
      };
    }
  }

  // Shared finisher: link to the current account if `state` is a valid link
  // token, otherwise sign in / create, then redirect back to the SPA.
  private async finishOauth(
    res: Response,
    provider: Provider,
    identity: {
      oauthId: string;
      email: string;
      emailVerified: boolean;
      name?: string;
      wcaId?: string | null;
    },
    state: string | undefined,
  ) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    if (state) {
      const userId = this.authService.verifyLinkToken(state);
      if (userId) {
        try {
          await this.authService.linkOauth(userId, {
            provider,
            oauthId: identity.oauthId,
            wcaId: identity.wcaId,
          });
          res.redirect(`${webUrl}/settings?linked=${provider}`);
        } catch {
          res.redirect(`${webUrl}/settings?error=link_conflict`);
        }
        return;
      }
    }
    // Sign-in flow: the callback MUST carry the signed sign-in `state` we minted
    // when starting the redirect. A missing/invalid state means the callback
    // didn't originate from our initiation endpoint (CSRF) — refuse it.
    if (!state || !this.authService.verifySignInState(state)) {
      res.redirect(`${webUrl}/login?error=${provider}`);
      return;
    }
    const result = await this.authService.oauthLogin({ provider, ...identity });
    const q = new URLSearchParams({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    res.redirect(`${webUrl}/login?${q.toString()}`);
  }

  @Get('google')
  googleAuth(@Query('state') state: string, @Res() res: Response) {
    const cfg = this.oauthConfig('google');
    if (!cfg) return res.status(503).json({ message: 'Google sign-in is not configured.' });
    // Link flow passes its own `state` (a link token); a plain sign-in gets a
    // freshly minted signed state so the callback can validate it (CSRF).
    const oauthState = state || this.authService.mintSignInState();
    res.redirect(this.authorizeUrl('google', cfg, oauthState));
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const cfg = this.oauthConfig('google');
    if (!cfg || !code) return res.redirect(`${webUrl}/login?error=google`);
    try {
      const identity = await this.fetchIdentity('google', code, cfg);
      await this.finishOauth(res, 'google', identity, state);
    } catch {
      res.redirect(`${webUrl}/login?error=google`);
    }
  }

  @Get('wca')
  wcaAuth(@Query('state') state: string, @Res() res: Response) {
    const cfg = this.oauthConfig('wca');
    if (!cfg) return res.status(503).json({ message: 'WCA sign-in is not configured.' });
    // Link flow passes its own `state` (a link token); a plain sign-in gets a
    // freshly minted signed state so the callback can validate it (CSRF).
    const oauthState = state || this.authService.mintSignInState();
    res.redirect(this.authorizeUrl('wca', cfg, oauthState));
  }

  @Get('wca/callback')
  async wcaCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const cfg = this.oauthConfig('wca');
    if (!cfg || !code) return res.redirect(`${webUrl}/login?error=wca`);
    try {
      const identity = await this.fetchIdentity('wca', code, cfg);
      await this.finishOauth(res, 'wca', identity, state);
    } catch {
      res.redirect(`${webUrl}/login?error=wca`);
    }
  }
}
