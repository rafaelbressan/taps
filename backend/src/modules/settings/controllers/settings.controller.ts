import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtPayload } from '../../auth/services/jwt-auth.service';
import { SettingsService } from '../services/settings.service';
import {
  UpdateSettingsDto,
  UpdateModeDto,
  SettingsResponse,
  SystemStatusResponse,
} from '../dto/settings.dto';

/**
 * Settings Controller
 *
 * Manages baker settings and system configuration
 * Replaces ColdFusion settings management
 */
@ApiTags('settings')
@Controller('settings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Get current settings
   * GET /settings
   */
  @Get()
  @ApiOperation({ summary: 'Get baker settings' })
  @ApiResponse({
    status: 200,
    description: 'Settings retrieved successfully',
    type: SettingsResponse,
  })
  async getSettings(
    @CurrentUser() user: JwtPayload,
  ): Promise<SettingsResponse> {
    this.logger.log(`Getting settings for user: ${user.username}`);
    return await this.settingsService.getSettings(user.sub);
  }

  /**
   * Update settings
   * PATCH /settings
   */
  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update baker settings' })
  @ApiResponse({
    status: 200,
    description: 'Settings updated successfully',
    type: SettingsResponse,
  })
  async updateSettings(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateSettingsDto,
  ): Promise<SettingsResponse> {
    this.logger.log(`Updating settings for user: ${user.username}`);
    return await this.settingsService.updateSettings(user.sub, dto);
  }

  /**
   * Update operation mode
   * PATCH /settings/mode
   */
  @Patch('mode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Update operation mode' })
  @ApiResponse({
    status: 204,
    description: 'Mode updated successfully',
  })
  async updateMode(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateModeDto,
  ): Promise<void> {
    this.logger.log(`Updating mode for user: ${user.username} to: ${dto.mode}`);
    await this.settingsService.updateMode(user.sub, dto.mode);
  }

  /**
   * Get system status
   * GET /settings/status
   */
  @Get('status')
  @ApiOperation({ summary: 'Get system status and statistics' })
  @ApiResponse({
    status: 200,
    description: 'System status retrieved successfully',
    type: SystemStatusResponse,
  })
  async getSystemStatus(
    @CurrentUser() user: JwtPayload,
  ): Promise<SystemStatusResponse> {
    this.logger.log(`Getting system status for user: ${user.username}`);
    return await this.settingsService.getSystemStatus(user.sub);
  }
}
