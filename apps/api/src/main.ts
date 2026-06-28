import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

class CustomIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: any): any {
    const corsOrigins = process.env.CORS_ORIGIN?.split(',') || [
      'http://localhost:3000',
      'https://plus2.me',
      'https://www.plus2.me',
    ];
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: corsOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      allowEIO3: true,
    });
    return server;
  }
}

async function bootstrap() {
  // Fail fast in production if JWT secrets aren't configured, rather than
  // silently running with the publicly-known development fallbacks (which would
  // let anyone forge valid tokens).
  if (process.env.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
      if (!process.env[key]) {
        throw new Error(`${key} must be set in production`);
      }
    }
  }

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') || [
      'http://localhost:3000',
      'https://plus2.me',
      'https://www.plus2.me',
    ],
    credentials: true,
  });

  // Configure WebSocket adapter
  app.useWebSocketAdapter(new CustomIoAdapter(app));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api', {
    exclude: ['health'],
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 Plus2 API running on http://localhost:${port}`);
}

bootstrap();
