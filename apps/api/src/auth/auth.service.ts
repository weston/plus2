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
    // Check if email exists
    const existingEmail = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingEmail) {
      throw new ConflictException('Email already registered');
    }

    // Check if username exists
    const existingUsername = await this.userRepository.findOne({
      where: { username: dto.username },
    });
    if (existingUsername) {
      throw new ConflictException('Username already taken');
    }

    // Validate username format
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(dto.username)) {
      throw new BadRequestException(
        'Username must be 3-32 characters and contain only letters, numbers, and underscores',
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Create user
    const user = this.userRepository.create({
      email: dto.email.toLowerCase(),
      username: dto.username,
      passwordHash,
    });

    await this.userRepository.save(user);

    // Create puzzle stats for each size
    const statsPromises = PUZZLE_SIZES.map((size) =>
      this.statsRepository.save(
        this.statsRepository.create({
          userId: user.id,
          puzzleSize: size,
        }),
      ),
    );
    await Promise.all(statsPromises);

    // Create default keybinding profile
    await this.keybindingsRepository.save(
      this.keybindingsRepository.create({
        userId: user.id,
        name: 'Default',
        isActive: true,
        bindings: DEFAULT_KEYBINDINGS,
      }),
    );

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
