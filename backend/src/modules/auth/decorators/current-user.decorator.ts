import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from '../services/jwt-auth.service';

/**
 * Current User Decorator
 *
 * Extracts current user from JWT token in request
 *
 * Usage:
 * @Get('me')
 * @UseGuards(JwtAuthGuard)
 * async getCurrentUser(@CurrentUser() user: JwtPayload) {
 *   return user;
 * }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    // If a specific field is requested, return just that field
    return data ? user?.[data] : user;
  },
);
