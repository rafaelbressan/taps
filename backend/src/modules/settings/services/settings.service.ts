import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  SettingsRepository,
  PaymentsRepository,
  DelegatorsPaymentsRepository,
  BondPoolRepository,
} from '../../../database/repositories';
import { TezosClientService } from '../../blockchain/services/tezos-client.service';
import {
  UpdateSettingsDto,
  SettingsResponse,
  SystemStatusResponse,
  OperationMode,
} from '../dto/settings.dto';

/**
 * Settings Service
 *
 * Manages baker settings and system status
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly delegatorsPaymentsRepo: DelegatorsPaymentsRepository,
    private readonly bondPoolRepo: BondPoolRepository,
    private readonly tezosClient: TezosClientService,
  ) {}

  /**
   * Get settings for baker
   */
  async getSettings(bakerId: string): Promise<SettingsResponse> {
    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new NotFoundException(`Settings not found for baker: ${bakerId}`);
    }

    return {
      baker_id: settings.bakerId,
      username: settings.userName || '',
      default_fee: settings.defaultFee,
      mode: settings.mode as OperationMode,
      adm_charge: settings.admCharge,
      min_payment: settings.minPayment,
      over_del: settings.overDel,
      email: settings.email,
      has_wallet: settings.hasWalletCredentials(),
      created_at: settings.createdAt,
      updated_at: settings.updatedAt,
    };
  }

  /**
   * Update settings
   */
  async updateSettings(
    bakerId: string,
    dto: UpdateSettingsDto,
  ): Promise<SettingsResponse> {
    this.logger.log(`Updating settings for baker: ${bakerId}`);

    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new NotFoundException(`Settings not found for baker: ${bakerId}`);
    }

    // Update only provided fields
    const updateData: any = {};

    if (dto.defaultFee !== undefined) updateData.defaultFee = dto.defaultFee;
    if (dto.mode !== undefined) updateData.mode = dto.mode;
    if (dto.admCharge !== undefined) updateData.admCharge = dto.admCharge;
    if (dto.minPayment !== undefined) updateData.minPayment = dto.minPayment;
    if (dto.overDel !== undefined) updateData.overDel = dto.overDel;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.notificationSettings !== undefined) {
      updateData.notificationSettings = dto.notificationSettings;
    }

    await this.settingsRepo.update(bakerId, updateData);

    this.logger.log(`Settings updated successfully for baker: ${bakerId}`);

    return this.getSettings(bakerId);
  }

  /**
   * Update operation mode
   */
  async updateMode(bakerId: string, mode: OperationMode): Promise<void> {
    this.logger.log(`Updating mode to "${mode}" for baker: ${bakerId}`);

    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new NotFoundException(`Settings not found for baker: ${bakerId}`);
    }

    await this.settingsRepo.update(bakerId, { mode });

    this.logger.log(`Mode updated successfully to "${mode}" for baker: ${bakerId}`);
  }

  /**
   * Get system status with aggregated data
   */
  async getSystemStatus(bakerId: string): Promise<SystemStatusResponse> {
    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new NotFoundException(`Settings not found for baker: ${bakerId}`);
    }

    // Get current cycle
    const currentCycle = await this.tezosClient.getCurrentCycle();

    // Get pending cycle (next cycle to be paid)
    const pendingCycle = await this.getPendingCycle(bakerId, currentCycle);

    // Get delegator statistics
    const allDelegatorPayments =
      await this.delegatorsPaymentsRepo.findAll();

    const delegatorsByBaker = allDelegatorPayments.filter(
      (dp) => dp.bakerId === bakerId,
    );

    const totalDelegators = new Set(
      delegatorsByBaker.map((dp) => dp.delegatorAddress),
    ).size;

    const activeDelegators = delegatorsByBaker.filter(
      (dp) => dp.paymentValue > 0,
    ).length;

    // Get total rewards paid
    const allPayments = await this.paymentsRepo.findByBakerId(bakerId);
    const totalRewardsPaid = allPayments.reduce(
      (sum, payment) => sum + Number(payment.total),
      0,
    );

    // Get baker balance
    let bakerBalance = 0;
    let bakerAddress = settings.bakerId;

    if (settings.hasWalletCredentials()) {
      try {
        bakerBalance = await this.tezosClient.getBalance(bakerAddress);
      } catch (error) {
        this.logger.warn(`Failed to get baker balance: ${error.message}`);
      }
    }

    // Get bond pool status
    const bondPoolSettings =
      await this.bondPoolRepo.findSettingsByBakerId(bakerId);
    const bondPoolEnabled = bondPoolSettings?.isEnabled() || false;

    // Get last payment date
    const lastPayment = allPayments
      .filter((p) => p.isPaid())
      .sort((a, b) => b.date.getTime() - a.date.getTime())[0];

    const lastPaymentDate = lastPayment?.date || null;

    // Determine health status
    const healthStatus = this.determineHealthStatus(
      settings,
      currentCycle,
      pendingCycle,
    );

    return {
      mode: settings.mode as OperationMode,
      current_cycle: currentCycle,
      pending_cycle: pendingCycle,
      total_delegators: totalDelegators,
      active_delegators: activeDelegators,
      baker_address: bakerAddress,
      baker_balance: bakerBalance,
      total_rewards_paid: totalRewardsPaid,
      bond_pool_enabled: bondPoolEnabled,
      last_payment_date: lastPaymentDate,
      health_status: healthStatus,
    };
  }

  /**
   * Get next pending cycle to be paid
   */
  private async getPendingCycle(bakerId: string, currentCycle: number): Promise<number> {
    const allPayments = await this.paymentsRepo.findByBakerId(bakerId);

    if (allPayments.length === 0) {
      // No payments yet, return current cycle
      return currentCycle;
    }

    // Find the latest paid cycle
    const paidPayments = allPayments.filter((p) => p.isPaid());

    if (paidPayments.length === 0) {
      // No paid payments, return earliest pending cycle
      const pendingPayments = allPayments.filter((p) => p.isPending());

      if (pendingPayments.length > 0) {
        return Math.min(...pendingPayments.map((p) => p.cycle));
      }

      return currentCycle;
    }

    // Return next cycle after last paid
    const lastPaidCycle = Math.max(...paidPayments.map((p) => p.cycle));
    return lastPaidCycle + 1;
  }

  /**
   * Determine system health status
   */
  private determineHealthStatus(
    settings: any,
    currentCycle: number,
    pendingCycle: number,
  ): 'healthy' | 'warning' | 'error' {
    // Error conditions
    if (!settings.hasWalletCredentials()) {
      return 'error'; // No wallet configured
    }

    if (settings.mode === 'off') {
      return 'warning'; // System is off
    }

    // Warning conditions
    const cycleGap = currentCycle - pendingCycle;

    if (cycleGap > 10) {
      return 'warning'; // More than 10 cycles behind
    }

    if (settings.mode === 'simulation') {
      return 'warning'; // In simulation mode
    }

    return 'healthy';
  }
}
