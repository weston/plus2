import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async validateUser(payload: JwtPayload): Promise<User | null> {
    return this.userRepository.findOne({ where: { id: payload.sub } });
  }

  /**
   * Find-or-create a user from an OAuth provider profile (e.g. Google SSO),
   * then issue tokens. Links to an existing account by provider id, else email.
   */
  async oauthLogin(params: {
    provider: string;
    oauthId: string;
    email: string;
    name?: string;
    wcaId?: string | null;
  }) {
    const email = params.email.toLowerCase();

    // 1. Existing OAuth link
    let user = await this.userRepository.findOne({
      where: { oauthProvider: params.provider, oauthId: params.oauthId },
    });

    // 2. Existing local account with the same email — link it
    if (!user) {
      user = await this.userRepository.findOne({ where: { email } });
      if (user) {
        user.oauthProvider = params.provider;
        user.oauthId = params.oauthId;
        await this.userRepository.save(user);
      }
    }

    // 3. Brand new account (with default stats + keybindings, like register)
    if (!user) {
      const username = await this.generateUniqueUsername(params.name || email.split('@')[0]);
      user = await this.userRepository.manager.transaction(async (manager) => {
        const created = await manager.save(
          manager.create(User, {
            email,
            username,
            passwordHash: null,
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
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET || 'plus2-refresh-secret',
      expiresIn: '14d',
    });

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
