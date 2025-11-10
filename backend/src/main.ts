import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HELMET_CONFIG, CORS_CONFIG } from './config/security.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', 3000);

  // Security - Helmet (HTTP headers protection)
  app.use(helmet(HELMET_CONFIG));
  logger.log('✓ Security headers configured (Helmet)');

  // CORS - Cross-Origin Resource Sharing
  app.enableCors(CORS_CONFIG);
  logger.log('✓ CORS configured');

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global prefix
  app.setGlobalPrefix('api');

  await app.listen(port);

  console.log(`🚀 TAPS Backend running on: http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/api/health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
}

bootstrap();
