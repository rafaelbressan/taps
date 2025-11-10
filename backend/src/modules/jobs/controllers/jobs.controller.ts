import {
  Controller,
  Post,
  Get,
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
import { JobSchedulerService } from '../services/job-scheduler.service';

/**
 * Jobs Controller
 *
 * Manual triggers and status for background jobs
 */
@ApiTags('jobs')
@Controller('jobs')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(private readonly jobScheduler: JobSchedulerService) {}

  /**
   * Trigger manual cycle check
   * POST /jobs/trigger/cycle-check
   */
  @Post('trigger/cycle-check')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Manually trigger cycle check' })
  @ApiResponse({
    status: 202,
    description: 'Cycle check job queued',
  })
  async triggerCycleCheck(@CurrentUser() user: JwtPayload): Promise<{
    message: string;
  }> {
    this.logger.log(`Manual cycle check triggered by user: ${user.username}`);

    await this.jobScheduler.triggerCycleCheck(user.sub);

    return {
      message: 'Cycle check job queued successfully',
    };
  }

  /**
   * Trigger manual balance poll
   * POST /jobs/trigger/balance-poll
   */
  @Post('trigger/balance-poll')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Manually trigger balance poll' })
  @ApiResponse({
    status: 202,
    description: 'Balance poll job queued',
  })
  async triggerBalancePoll(@CurrentUser() user: JwtPayload): Promise<{
    message: string;
  }> {
    this.logger.log(`Manual balance poll triggered by user: ${user.username}`);

    await this.jobScheduler.triggerBalancePoll(user.sub);

    return {
      message: 'Balance poll job queued successfully',
    };
  }

  /**
   * Get job schedule status
   * GET /jobs/status
   */
  @Get('status')
  @ApiOperation({ summary: 'Get status of scheduled jobs' })
  @ApiResponse({
    status: 200,
    description: 'Job schedule status',
  })
  async getJobStatus(@CurrentUser() user: JwtPayload): Promise<{
    cycleMonitoring: any;
    balancePolling: any;
  }> {
    this.logger.log(`Getting job status for user: ${user.username}`);

    return await this.jobScheduler.getScheduleStatus(user.sub);
  }

  /**
   * Initialize job schedules
   * POST /jobs/initialize
   */
  @Post('initialize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initialize job schedules for current baker' })
  @ApiResponse({
    status: 200,
    description: 'Job schedules initialized',
  })
  async initializeSchedules(@CurrentUser() user: JwtPayload): Promise<{
    message: string;
  }> {
    this.logger.log(`Initializing job schedules for user: ${user.username}`);

    await this.jobScheduler.initializeSchedules(user.sub);

    return {
      message: 'Job schedules initialized successfully',
    };
  }

  /**
   * Remove job schedules
   * POST /jobs/remove
   */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove job schedules for current baker' })
  @ApiResponse({
    status: 200,
    description: 'Job schedules removed',
  })
  async removeSchedules(@CurrentUser() user: JwtPayload): Promise<{
    message: string;
  }> {
    this.logger.log(`Removing job schedules for user: ${user.username}`);

    await this.jobScheduler.removeSchedule(user.sub);

    return {
      message: 'Job schedules removed successfully',
    };
  }
}
