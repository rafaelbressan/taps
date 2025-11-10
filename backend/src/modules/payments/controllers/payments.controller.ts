import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { WalletAuthGuard } from '../../auth/guards/wallet-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtPayload } from '../../auth/services/jwt-auth.service';
import { PaymentsRepository, DelegatorsPaymentsRepository } from '../../../database/repositories';
import { DistributionOrchestratorService } from '../../rewards/services/distribution-orchestrator.service';
import {
  PaymentHistoryQueryDto,
  PaginatedPaymentResponse,
  CyclePaymentResponse,
  DistributionResponse,
  PaymentResponse,
  DelegatorPaymentDetail,
  PaymentStatus,
} from '../dto/payments.dto';

/**
 * Payments Controller
 *
 * Manages payment history and distribution
 */
@ApiTags('payments')
@Controller('payments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paymentsRepo: PaymentsRepository,
    private readonly delegatorsPaymentsRepo: DelegatorsPaymentsRepository,
    private readonly distributionOrchestrator: DistributionOrchestratorService,
  ) {}

  /**
   * Get payment history with pagination
   * GET /payments/history
   */
  @Get('history')
  @ApiOperation({ summary: 'Get paginated payment history' })
  @ApiResponse({
    status: 200,
    description: 'Payment history retrieved successfully',
    type: PaginatedPaymentResponse,
  })
  async getPaymentHistory(
    @CurrentUser() user: JwtPayload,
    @Query() query: PaymentHistoryQueryDto,
  ): Promise<PaginatedPaymentResponse> {
    this.logger.log(`Getting payment history for user: ${user.username}`);

    const { page = 1, limit = 20, status, startDate, endDate } = query;

    // Get all payments for baker
    let payments = await this.paymentsRepo.findByBakerId(user.sub);

    // Apply filters
    if (status) {
      payments = payments.filter((p) => p.result === status);
    }

    if (startDate) {
      const start = new Date(startDate);
      payments = payments.filter((p) => p.date >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      payments = payments.filter((p) => p.date <= end);
    }

    // Sort by date descending
    payments.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Paginate
    const total = payments.length;
    const totalPages = Math.ceil(total / limit);
    const skip = (page - 1) * limit;
    const paginatedPayments = payments.slice(skip, skip + limit);

    // Map to response format
    const data: PaymentResponse[] = paginatedPayments.map((p) => ({
      cycle: p.cycle,
      date: p.date,
      gross_rewards: p.grossRewards,
      net_rewards: p.netRewards,
      baker_fee: p.bakerFee,
      delegators_count: p.delegatorsCount,
      status: p.result as PaymentStatus,
      transaction_hash: p.transactionId,
      error_message: p.errorMessage,
    }));

    return {
      data,
      total,
      page,
      limit,
      total_pages: totalPages,
    };
  }

  /**
   * Get payments for specific cycle
   * GET /payments/cycle/:cycle
   */
  @Get('cycle/:cycle')
  @ApiOperation({ summary: 'Get payment details for a specific cycle' })
  @ApiParam({ name: 'cycle', description: 'Tezos cycle number' })
  @ApiResponse({
    status: 200,
    description: 'Cycle payment details retrieved successfully',
    type: CyclePaymentResponse,
  })
  async getCyclePayments(
    @CurrentUser() user: JwtPayload,
    @Param('cycle', ParseIntPipe) cycle: number,
  ): Promise<CyclePaymentResponse> {
    this.logger.log(`Getting payments for cycle ${cycle}, user: ${user.username}`);

    // Get payment record
    const payment = await this.paymentsRepo.findByCycle(user.sub, cycle);

    if (!payment) {
      throw new BadRequestException(`No payment found for cycle ${cycle}`);
    }

    // Get delegator payments for this cycle
    const delegatorPayments = await this.delegatorsPaymentsRepo.findByCycle(
      user.sub,
      cycle,
    );

    const delegatorDetails: DelegatorPaymentDetail[] = delegatorPayments.map(
      (dp) => ({
        address: dp.delegatorAddress,
        amount: dp.paymentValue,
        fee: dp.fee,
        balance: dp.balance,
        status: dp.result as PaymentStatus,
        transaction_hash: dp.transactionId,
      }),
    );

    return {
      cycle: payment.cycle,
      payment: {
        cycle: payment.cycle,
        date: payment.date,
        gross_rewards: payment.grossRewards,
        net_rewards: payment.netRewards,
        baker_fee: payment.bakerFee,
        delegators_count: payment.delegatorsCount,
        status: payment.result as PaymentStatus,
        transaction_hash: payment.transactionId,
        error_message: payment.errorMessage,
      },
      delegator_payments: delegatorDetails,
    };
  }

  /**
   * Get pending cycle number
   * GET /payments/pending
   */
  @Get('pending')
  @ApiOperation({ summary: 'Get next pending cycle to be paid' })
  @ApiResponse({
    status: 200,
    description: 'Pending cycle number',
    schema: { type: 'object', properties: { cycle: { type: 'number' } } },
  })
  async getPendingCycle(
    @CurrentUser() user: JwtPayload,
  ): Promise<{ cycle: number }> {
    this.logger.log(`Getting pending cycle for user: ${user.username}`);

    const payments = await this.paymentsRepo.findByBakerId(user.sub);

    // Find pending payments
    const pendingPayments = payments.filter((p) => p.result === 'pending');

    if (pendingPayments.length > 0) {
      const nextCycle = Math.min(...pendingPayments.map((p) => p.cycle));
      return { cycle: nextCycle };
    }

    // No pending payments, return next cycle after last paid
    const paidPayments = payments.filter((p) => p.result === 'paid');

    if (paidPayments.length > 0) {
      const lastPaidCycle = Math.max(...paidPayments.map((p) => p.cycle));
      return { cycle: lastPaidCycle + 1 };
    }

    // No payments at all, return current cycle
    return { cycle: 0 };
  }

  /**
   * Distribute rewards for a specific cycle
   * POST /payments/distribute/:cycle
   *
   * Requires wallet passphrase for security
   */
  @Post('distribute/:cycle')
  @UseGuards(WalletAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Distribute rewards for a specific cycle' })
  @ApiParam({ name: 'cycle', description: 'Tezos cycle number' })
  @ApiResponse({
    status: 200,
    description: 'Rewards distributed successfully',
    type: DistributionResponse,
  })
  async distributeCycleRewards(
    @CurrentUser() user: JwtPayload,
    @Param('cycle', ParseIntPipe) cycle: number,
  ): Promise<DistributionResponse> {
    this.logger.log(
      `Distributing rewards for cycle ${cycle}, user: ${user.username}`,
    );

    try {
      // Execute full distribution workflow
      const result = await this.distributionOrchestrator.processRewardsDistribution(
        user.sub,
      );

      return {
        cycle: result.delegatorDistribution.cycle,
        success: result.delegatorDistribution.success,
        delegators_paid: result.delegatorDistribution.delegatorsPaid,
        total_distributed: result.delegatorDistribution.totalDistributed,
        transaction_hashes: result.delegatorDistribution.transactionHashes,
      };
    } catch (error) {
      this.logger.error(`Distribution failed for cycle ${cycle}: ${error.message}`);

      return {
        cycle,
        success: false,
        delegators_paid: 0,
        total_distributed: 0,
        transaction_hashes: [],
        error_message: error.message,
      };
    }
  }
}
