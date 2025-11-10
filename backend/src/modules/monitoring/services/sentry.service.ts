import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';

/**
 * Sentry Service
 *
 * Handles error tracking and monitoring with Sentry
 */
@Injectable()
export class SentryService implements OnModuleInit {
  private readonly logger = new Logger(SentryService.name);
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initializeSentry();
  }

  /**
   * Initialize Sentry with configuration
   */
  private initializeSentry(): void {
    const dsn = this.configService.get<string>('SENTRY_DSN');
    const environment = this.configService.get<string>(
      'SENTRY_ENVIRONMENT',
      'development',
    );

    // Only initialize if DSN is provided
    if (!dsn) {
      this.logger.warn(
        'Sentry DSN not configured - error tracking disabled',
      );
      return;
    }

    try {
      Sentry.init({
        dsn,
        environment,
        tracesSampleRate: this.configService.get<number>(
          'SENTRY_TRACES_SAMPLE_RATE',
          0.1,
        ),
        profilesSampleRate: this.configService.get<number>(
          'SENTRY_PROFILES_SAMPLE_RATE',
          0.1,
        ),
        attachStacktrace: this.configService.get<boolean>(
          'SENTRY_ATTACH_STACKTRACE',
          true,
        ),
        debug: this.configService.get<boolean>('SENTRY_DEBUG', false),
        beforeSend: (event, hint) => {
          // Filter out sensitive data
          return this.filterSensitiveData(event);
        },
        integrations: [
          new Sentry.Integrations.Http({ tracing: true }),
          new Sentry.Integrations.OnUncaughtException(),
          new Sentry.Integrations.OnUnhandledRejection(),
        ],
      });

      this.initialized = true;
      this.logger.log(`Sentry initialized for ${environment} environment`);
    } catch (error) {
      this.logger.error('Failed to initialize Sentry', error);
    }
  }

  /**
   * Capture an exception
   */
  captureException(error: Error, context?: Record<string, any>): void {
    if (!this.initialized) return;

    try {
      Sentry.withScope((scope) => {
        if (context) {
          Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
          });
        }
        Sentry.captureException(error);
      });
    } catch (err) {
      this.logger.error('Failed to capture exception in Sentry', err);
    }
  }

  /**
   * Capture a message
   */
  captureMessage(
    message: string,
    level: Sentry.SeverityLevel = 'info',
    context?: Record<string, any>,
  ): void {
    if (!this.initialized) return;

    try {
      Sentry.withScope((scope) => {
        scope.setLevel(level);
        if (context) {
          Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
          });
        }
        Sentry.captureMessage(message);
      });
    } catch (err) {
      this.logger.error('Failed to capture message in Sentry', err);
    }
  }

  /**
   * Set user context
   */
  setUser(user: { id: string; username?: string; email?: string }): void {
    if (!this.initialized) return;

    try {
      Sentry.setUser({
        id: user.id,
        username: user.username,
        email: user.email,
      });
    } catch (err) {
      this.logger.error('Failed to set user context in Sentry', err);
    }
  }

  /**
   * Clear user context
   */
  clearUser(): void {
    if (!this.initialized) return;

    try {
      Sentry.setUser(null);
    } catch (err) {
      this.logger.error('Failed to clear user context in Sentry', err);
    }
  }

  /**
   * Add breadcrumb
   */
  addBreadcrumb(
    message: string,
    category?: string,
    data?: Record<string, any>,
  ): void {
    if (!this.initialized) return;

    try {
      Sentry.addBreadcrumb({
        message,
        category,
        data,
        timestamp: Date.now() / 1000,
      });
    } catch (err) {
      this.logger.error('Failed to add breadcrumb in Sentry', err);
    }
  }

  /**
   * Start a transaction for performance monitoring
   */
  startTransaction(name: string, op: string): Sentry.Transaction | null {
    if (!this.initialized) return null;

    try {
      return Sentry.startTransaction({
        name,
        op,
      });
    } catch (err) {
      this.logger.error('Failed to start transaction in Sentry', err);
      return null;
    }
  }

  /**
   * Filter sensitive data from Sentry events
   */
  private filterSensitiveData(event: Sentry.Event): Sentry.Event {
    // Remove sensitive headers
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
      delete event.request.headers['x-api-key'];
    }

    // Remove sensitive query parameters
    if (event.request?.query_string) {
      const sensitiveParams = ['password', 'token', 'secret', 'passphrase'];
      sensitiveParams.forEach((param) => {
        if (event.request?.query_string?.includes(param)) {
          event.request.query_string = '[FILTERED]';
        }
      });
    }

    // Remove sensitive data from extra context
    if (event.extra) {
      const sensitiveKeys = [
        'password',
        'passHash',
        'phrase',
        'walletHash',
        'walletSalt',
        'privateKey',
        'mnemonic',
      ];

      sensitiveKeys.forEach((key) => {
        if (event.extra && event.extra[key]) {
          event.extra[key] = '[FILTERED]';
        }
      });
    }

    return event;
  }

  /**
   * Flush pending events
   */
  async flush(timeout = 2000): Promise<boolean> {
    if (!this.initialized) return true;

    try {
      return await Sentry.flush(timeout);
    } catch (err) {
      this.logger.error('Failed to flush Sentry events', err);
      return false;
    }
  }
}
