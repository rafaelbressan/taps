import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HELMET_CONFIG, CORS_CONFIG } from './config/security.config';
import { AllExceptionsFilter } from './shared/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', 3000);
  const env = configService.get<string>('env', 'development');

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
  logger.log('✓ Global validation pipe configured');

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());
  logger.log('✓ Global exception filter configured');

  // Global prefix
  app.setGlobalPrefix('api');

  // Swagger API documentation
  if (env !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('TAPS API')
      .setDescription(
        'Tezos Automatic Payment System - RESTful API for managing baker rewards distribution',
      )
      .setVersion('2.0.0')
      .addBearerAuth()
      .addTag('auth', 'Authentication endpoints')
      .addTag('settings', 'Baker settings and configuration')
      .addTag('payments', 'Payment history and distribution')
      .addTag('rewards', 'Rewards calculation and projections')
      .addTag('delegators', 'Delegator management')
      .addTag('bond-pool', 'Bond pool management')
      .addTag('wallet', 'Wallet operations')
      .addTag('reports', 'Reports and exports')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'TAPS API Documentation',
      customCss: '.swagger-ui .topbar { display: none }',
    });

    logger.log(`📚 Swagger documentation: http://localhost:${port}/api/docs`);
  }

  await app.listen(port);

  console.log(`🚀 TAPS Backend running on: http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/api/health`);
  console.log(`📚 API Docs: http://localhost:${port}/api/docs`);
  console.log(`🌍 Environment: ${env}`);
}

bootstrap();
