import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { User } from '../users/user.entity';
import { UserPuzzleStats } from '../users/user-puzzle-stats.entity';
import { KeybindingProfile } from '../keybindings/keybinding-profile.entity';
import { RegisterDto, LoginDto } from './auth.dto';
import { DEFAULT_KEYBINDINGS, PUZZLE_SIZES } from '@plus2/shared';

export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserPuzzleStats)
    private statsRepository: Repository<UserPuzzleStats>,
    @InjectRepository(KeybindingProfile)
    private keybindingsRepository: Repository<KeybindingProfile>,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    // Validate username format first
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(dto.username)) {
      throw new BadRequestException(
        'Username must be 3-32 characters and contain only letters, numbers, and underscores',
      );
    }

    const email = dto.email.toLowerCase();

    // Check if email exists
    const existingEmail = await this.userRepository.findOne({ where: { email } });
    if (existingEmail) {
      throw new ConflictException('Email already registered');
    }

    // Check if username exists (case-insensitive, so "Bob" and "bob" can't coexist)
    const existingUsername = await this.userRepository
      .createQueryBuilder('user')
      .where('LOWER(user.username) = LOWER(:username)', { username: dto.username })
      .getOne();
    if (existingUsername) {
      throw new ConflictException('Username already taken');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Create the user, puzzle stats and default keybinding profile atomically.
    // A failure can't leave an orphaned user row, and a lost race on the unique
    // constraint surfaces as a ConflictException rather than a raw 500.
    let user: User;
    try {
      user = await this.userRepository.manager.transaction(async (manager) => {
        const created = await manager.save(
          manager.create(User, { email, username: dto.username, passwordHash }),
        );

        await Promise.all(
          PUZZLE_SIZES.map((size) =>
            manager.save(
              manager.create(UserPuzzleStats, { userId: created.id, puzzleSize: size }),
            ),
          ),
        );

        await manager.save(
          manager.create(KeybindingProfile, {
            userId: created.id,
            name: 'Default',
            isActive: true,
            bindings: DEFAULT_KEYBINDINGS,
          }),
        );

        return created;
      });
    } catch (err: any) {
      // Postgres unique_violation = 23505; sqlite/better-sqlite3 reports SQLITE_CONSTRAINT
      if (err?.code === '23505' || /unique/i.test(err?.message ?? '')) {
        throw new ConflictException('Email or username already taken');
      }
      throw err;
    }

    // Generate tokens
    const tokens = this.generateTokens(user);

    return {
      ...tokens,
      user: this.sanitizeUser(user),
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException('This account uses Google sign-in.');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    const tokens = this.generateTokens(user);

    return {
      ...tokens,
      user: this.sanitizeUser(user),
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET || 'plus2-refresh-secret',
      });

      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Reject refresh tokens minted before the last logout: logout bumps the
      // user's tokenVersion, so any token carrying an older `tv` is revoked.
      if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
        throw new UnauthorizedException('Refresh token revoked');
      }

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  /**
   * Server-side logout: bump the user's tokenVersion so every outstanding
   * refresh token (which embeds the old `tv`) is rejected on next refresh.
   */
  async logout(userId: string): Promise<void> {
    await this.userRepository.increment({ id: userId }, 'tokenVersion', 1);
  }

  async validateUser(payload: JwtPayload): Promise<User | null> {
    return this.userRepository.findOne({ where: { id: payload.sub } });
  }

  // Set the provider-specific identity column on a user (and keep the legacy
  // single-provider fields pointed at the most recent provider for back-compat).
  private applyIdentity(
    user: User,
    params: { provider: string; oauthId: string; wcaId?: string | null },
  ) {
    if (params.provider === 'google') {
      user.googleId = params.oauthId;
    } else if (params.provider === 'wca') {
      user.wcaOauthId = params.oauthId;
      if (params.wcaId) user.wcaId = params.wcaId;
    }
    user.oauthProvider = params.provider;
    user.oauthId = params.oauthId;
  }

  /**
   * Find-or-create a user from an OAuth provider profile, then issue tokens.
   * Resolves by the provider-specific id, else by email (auto-link), else creates.
   *
   * Auto-linking by email is only safe when the provider has VERIFIED the email —
   * otherwise anyone could set an unverified address at the provider to hijack an
   * existing account. WCA verifies emails; Google supplies `email_verified`.
   */
  async oauthLogin(params: {
    provider: string;
    oauthId: string;
    email: string;
    emailVerified: boolean;
    name?: string;
    wcaId?: string | null;
  }) {
    const email = params.email.toLowerCase();
    const idField = params.provider === 'google' ? 'googleId' : 'wcaOauthId';

    // 1. Existing identity link
    let user = await this.userRepository.findOne({
      where: { [idField]: params.oauthId } as any,
    });

    // 2. Existing account with the same email — auto-link this provider to it,
    //    but ONLY when the provider verified the incoming email. If it isn't
    //    verified we must not take over the account: email is unique so we can't
    //    create a distinct one either, so surface a clear error instead.
    if (!user) {
      const existingByEmail = await this.userRepository.findOne({ where: { email } });
      if (existingByEmail) {
        if (!params.emailVerified) {
          throw new ConflictException(
            'An account with this email already exists. Sign in to it and link this provider from settings.',
          );
        }
        user = existingByEmail;
        this.applyIdentity(user, params);
        await this.userRepository.save(user);
      }
    }

    // 3. Brand new account (with default stats + keybindings)
    if (!user) {
      const username = await this.generateUniqueUsername(params.name || email.split('@')[0]);
      user = await this.userRepository.manager.transaction(async (manager) => {
        const created = await manager.save(
          manager.create(User, {
            email,
            username,
            passwordHash: null,
            googleId: params.provider === 'google' ? params.oauthId : null,
            wcaOauthId: params.provider === 'wca' ? params.oauthId : null,
            wcaId: params.provider === 'wca' ? params.wcaId ?? null : null,
            oauthProvider: params.provider,
            oauthId: params.oauthId,
          }),
        );
        await Promise.all(
          PUZZLE_SIZES.map((size) =>
            manager.save(manager.create(UserPuzzleStats, { userId: created.id, puzzleSize: size })),
          ),
        );
        await manager.save(
          manager.create(KeybindingProfile, {
            userId: created.id,
            name: 'Default',
            isActive: true,
            bindings: DEFAULT_KEYBINDINGS,
          }),
        );
        return created;
      });
    }

    if (params.wcaId) user.wcaId = params.wcaId;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    return { ...this.generateTokens(user), user: this.sanitizeUser(user) };
  }

  /**
   * Attach a provider identity to the CURRENT (already-logged-in) account.
   * Errors if that identity is already linked to a different account.
   */
  async linkOauth(
    userId: string,
    params: { provider: string; oauthId: string; wcaId?: string | null },
  ): Promise<User> {
    const idField = params.provider === 'google' ? 'googleId' : 'wcaOauthId';
    const existing = await this.userRepository.findOne({
      where: { [idField]: params.oauthId } as any,
    });
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        `That ${params.provider === 'google' ? 'Google' : 'WCA'} account is already linked to another user.`,
      );
    }
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    this.applyIdentity(user, params);
    await this.userRepository.save(user);
    return user;
  }

  /** Short-lived token that carries the current user through a link OAuth round-trip. */
  mintLinkToken(userId: string): string {
    return this.jwtService.sign({ sub: userId, link: true }, { expiresIn: '10m' });
  }

  verifyLinkToken(token: string): string | null {
    try {
      const payload = this.jwtService.verify(token) as { sub?: string; link?: boolean };
      if (payload?.link === true && payload.sub) return payload.sub;
    } catch {
      /* invalid/expired */
    }
    return null;
  }

  /**
   * Short-lived signed `state` for an OAuth SIGN-IN round-trip. Carries a nonce
   * and a purpose so the callback can prove the request originated here (CSRF).
   */
  mintSignInState(): string {
    return this.jwtService.sign(
      { purpose: 'oauth_signin', nonce: randomUUID() },
      { expiresIn: '10m' },
    );
  }

  verifySignInState(token: string): boolean {
    try {
      const payload = this.jwtService.verify(token) as { purpose?: string };
      return payload?.purpose === 'oauth_signin';
    } catch {
      return false;
    }
  }

  private async generateUniqueUsername(base: string): Promise<string> {
    let clean = base.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'cuber';
    if (clean.length < 3) clean = `${clean}cuber`;
    let candidate = clean;
    let n = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = await this.userRepository
        .createQueryBuilder('u')
        .where('LOWER(u.username) = LOWER(:un)', { un: candidate })
        .getOne();
      if (!exists) return candidate;
      n += 1;
      candidate = `${clean}${n}`.slice(0, 32);
      if (n > 9999) return `${clean}${Date.now()}`.slice(0, 32);
    }
  }

  private generateTokens(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
    };

    const accessToken = this.jwtService.sign(payload);
    // The refresh token also carries the user's tokenVersion (`tv`) so logout can
    // revoke it (see refreshToken / logout). Access tokens are unaffected.
    const refreshToken = this.jwtService.sign(
      { ...payload, tv: user.tokenVersion ?? 0 },
      {
        secret: process.env.JWT_REFRESH_SECRET || 'plus2-refresh-secret',
        expiresIn: '14d',
      },
    );

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      mmr: user.mmr,
      league: user.league,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
