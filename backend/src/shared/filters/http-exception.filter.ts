import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Error response interface
 */
export interface ErrorResponse {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error?: string;
  details?: any;
}

/**
 * Global HTTP Exception Filter
 *
 * Catches all exceptions and formats them consistently
 * Provides better error messages than NestJS defaults
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';
    let details: any = undefined;

    // Handle HTTP exceptions
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as any;
        message = responseObj.message || exception.message;
        error = responseObj.error || exception.name;
        details = responseObj.details;
      } else {
        message = exceptionResponse as string;
        error = exception.name;
      }
    }
    // Handle validation errors
    else if (this.isValidationError(exception)) {
      status = HttpStatus.BAD_REQUEST;
      message = this.extractValidationMessages(exception);
      error = 'ValidationError';
    }
    // Handle database errors
    else if (this.isDatabaseError(exception)) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Database operation failed';
      error = 'DatabaseError';

      if (process.env.NODE_ENV === 'development') {
        details = {
          originalError: (exception as Error).message,
        };
      }
    }
    // Handle unknown errors
    else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name || 'Error';

      if (process.env.NODE_ENV === 'development') {
        details = {
          stack: exception.stack,
        };
      }
    }

    // Build error response
    const errorResponse: ErrorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
      error,
    };

    if (details) {
      errorResponse.details = details;
    }

    // Log error
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : exception,
      );
    } else if (status >= 400) {
      this.logger.warn(
        `${request.method} ${request.url} - ${JSON.stringify(message)}`,
      );
    }

    // Send response
    response.status(status).json(errorResponse);
  }

  /**
   * Check if error is a validation error
   */
  private isValidationError(exception: unknown): boolean {
    return (
      exception instanceof Error &&
      (exception.name === 'ValidationError' ||
        exception.message.includes('validation'))
    );
  }

  /**
   * Extract validation messages
   */
  private extractValidationMessages(exception: unknown): string[] {
    if (exception instanceof Error) {
      // Try to parse validation error details
      try {
        const match = exception.message.match(/\[([^\]]+)\]/);
        if (match) {
          return match[1].split(',').map((m) => m.trim());
        }
      } catch (e) {
        // Ignore parsing errors
      }

      return [exception.message];
    }

    return ['Validation failed'];
  }

  /**
   * Check if error is a database error
   */
  private isDatabaseError(exception: unknown): boolean {
    return (
      exception instanceof Error &&
      (exception.name.includes('Prisma') ||
        exception.name.includes('Database') ||
        exception.message.includes('database') ||
        exception.message.includes('ECONNREFUSED'))
    );
  }
}
