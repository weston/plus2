import { Controller, Post, Get, Body, Query, Res, HttpCode, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, RefreshTokenDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout() {
    // For JWT, logout is handled client-side by removing tokens
    return { message: 'Logged out successfully' };
  }

  // ===========================================================================
  // Google SSO (scaffold)
  //
  // SETUP (see SSO_WCA_SETUP.md): create an OAuth client in Google Cloud Console
  // and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and (optionally)
  // GOOGLE_CALLBACK_URL + WEB_URL. Add the callback URL as an authorized redirect
  // URI. Until those are set, these routes return a friendly "not configured".
  // ===========================================================================

  private googleConfig() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      callbackUrl:
        process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/google/callback',
    };
  }

  @Get('google')
  googleAuth(@Res() res: Response) {
    const cfg = this.googleConfig();
    if (!cfg) {
      res.status(503).json({ message: 'Google sign-in is not configured.' });
      return;
    }
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  }

  @Get('google/callback')
  async googleCallback(@Query('code') code: string, @Res() res: Response) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const cfg = this.googleConfig();
    if (!cfg || !code) {
      res.redirect(`${webUrl}/login?error=google`);
      return;
    }
    try {
      // Exchange the authorization code for tokens.
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
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
      if (!tokenData.access_token) throw new Error('No access token from Google');

      // Fetch the user's basic profile.
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = (await infoRes.json()) as { sub?: string; email?: string; name?: string };
      if (!profile.sub || !profile.email) throw new Error('Incomplete Google profile');

      const result = await this.authService.oauthLogin({
        provider: 'google',
        oauthId: profile.sub,
        email: profile.email,
        name: profile.name,
      });

      // Hand the tokens back to the SPA, which stores them and continues.
      const q = new URLSearchParams({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
      res.redirect(`${webUrl}/login?${q.toString()}`);
    } catch {
      res.redirect(`${webUrl}/login?error=google`);
    }
  }

  // ===========================================================================
  // WCA (World Cube Association) integration (scaffold)
  //
  // SETUP (see SSO_WCA_SETUP.md): register an OAuth application at
  // worldcubeassociation.org/oauth/applications and set WCA_CLIENT_ID,
  // WCA_CLIENT_SECRET, and (optionally) WCA_CALLBACK_URL + WEB_URL. Signing in
  // with WCA links the user's WCA ID; official records can then be pulled from
  // the public WCA API by wcaId (see UsersController.getWcaRecords).
  // ===========================================================================

  private wcaConfig() {
    const clientId = process.env.WCA_CLIENT_ID;
    const clientSecret = process.env.WCA_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      callbackUrl: process.env.WCA_CALLBACK_URL || 'http://localhost:3001/api/auth/wca/callback',
    };
  }

  @Get('wca')
  wcaAuth(@Res() res: Response) {
    const cfg = this.wcaConfig();
    if (!cfg) {
      res.status(503).json({ message: 'WCA sign-in is not configured.' });
      return;
    }
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.callbackUrl,
      response_type: 'code',
      scope: 'public email',
    });
    res.redirect(`https://www.worldcubeassociation.org/oauth/authorize?${params.toString()}`);
  }

  @Get('wca/callback')
  async wcaCallback(@Query('code') code: string, @Res() res: Response) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const cfg = this.wcaConfig();
    if (!cfg || !code) {
      res.redirect(`${webUrl}/login?error=wca`);
      return;
    }
    try {
      const tokenRes = await fetch('https://www.worldcubeassociation.org/oauth/token', {
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
      if (!tokenData.access_token) throw new Error('No access token from WCA');

      const meRes = await fetch('https://www.worldcubeassociation.org/api/v0/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const me = (await meRes.json()) as {
        me?: { id: number; wca_id: string | null; name?: string; email?: string };
      };
      const profile = me.me;
      if (!profile?.email) throw new Error('Incomplete WCA profile');

      const result = await this.authService.oauthLogin({
        provider: 'wca',
        oauthId: String(profile.id),
        email: profile.email,
        name: profile.name,
        wcaId: profile.wca_id,
      });

      const q = new URLSearchParams({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
      res.redirect(`${webUrl}/login?${q.toString()}`);
    } catch {
      res.redirect(`${webUrl}/login?error=wca`);
    }
  }
}
