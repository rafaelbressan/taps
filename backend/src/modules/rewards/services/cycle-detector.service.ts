import { Injectable, Logger } from '@nestjs/common';
import { TezosClientService } from '../../blockchain/services/tezos-client.service';
import { TzKTClientService } from '../../blockchain/services/tzkt-client.service';
import { PaymentsRepository } from '../../../database/repositories';
import { PaymentStatus, CYCLES_UNTIL_DELIVERED } from '../../../shared/constants';
import { PaymentEntity } from '../../../shared/entities';

/**
 * Cycle change detection result
 */
export interface CycleChangeResult {
  changed: boolean;
  previousCycle: number | null;
  currentCycle: number;
  pendingRewardsCycle: number | null; // Cycle with rewards ready to distribute
}

/**
 * Cycle Detector Service
 *
 * Detects when Tezos cycles change and identifies when rewards become available
 * Based on BUSINESS_LOGIC.md Section 3: "Cycle Change Detection"
 *
 * Key Concepts:
 * - Current cycle: The active cycle on the blockchain
 * - Pending rewards cycle: Cycle N - CYCLES_UNTIL_DELIVERED (where rewards are now available)
 * - Rewards delay: Tezos releases rewards after CYCLES_UNTIL_DELIVERED cycles (typically 5)
 */
@Injectable()
export class CycleDetectorService {
  private readonly logger = new Logger(CycleDetectorService.name);

  constructor(
    private readonly tezosClient: TezosClientService,
    private readonly tzktClient: TzKTClientService,
    private readonly paymentsRepo: PaymentsRepository,
  ) {}

  /**
   * Detect if cycle has changed since last check
   * Based on BUSINESS_LOGIC.md Section 3.1
   *
   * @param bakerId Baker ID
   * @returns CycleChangeResult with change status and cycle numbers
   */
  async detectCycleChange(bakerId: string): Promise<CycleChangeResult> {
    this.logger.log(`Detecting cycle change for baker ${bakerId}`);

    // Step 1: Get current cycle from blockchain
    const currentCycle = await this.tezosClient.getCurrentCycle();

    // Step 2: Get latest payment record (cycle being tracked)
    const latestPayment = await this.paymentsRepo.findLatest(bakerId);

    const previousCycle = latestPayment?.cycle || null;

    // Step 3: Calculate which cycle has rewards available now
    // Rewards for cycle N become available at cycle N + CYCLES_UNTIL_DELIVERED
    const pendingRewardsCycle = currentCycle - CYCLES_UNTIL_DELIVERED;

    // Step 4: Check if cycle has changed
    const changed = previousCycle !== null && currentCycle > previousCycle;

    this.logger.log(
      `Current cycle: ${currentCycle}, Previous: ${previousCycle}, Pending rewards: ${pendingRewardsCycle}, Changed: ${changed}`,
    );

    return {
      changed,
      previousCycle,
      currentCycle,
      pendingRewardsCycle: pendingRewardsCycle >= 0 ? pendingRewardsCycle : null,
    };
  }

  /**
   * Get the cycle with rewards pending distribution
   * This is the cycle that should be processed next
   */
  async getPendingRewardsCycle(bakerId: string): Promise<number | null> {
    // Check database for pending payments
    const pendingPayment = await this.paymentsRepo.findByStatus(
      PaymentStatus.REWARDS_PENDING,
    );

    if (pendingPayment.length > 0) {
      // Return the oldest pending cycle
      const oldest = pendingPayment.sort((a, b) => a.cycle - b.cycle)[0];
      return oldest.cycle;
    }

    // No pending in database, calculate from current cycle
    const cycleChange = await this.detectCycleChange(bakerId);
    return cycleChange.pendingRewardsCycle;
  }

  /**
   * Mark cycle as "rewards_pending" in payments table
   * Based on BUSINESS_LOGIC.md Section 1.1 Step 2
   */
  async markCyclePending(bakerId: string, cycle: number): Promise<void> {
    this.logger.log(`Marking cycle ${cycle} as pending for baker ${bakerId}`);

    // Check if payment record already exists
    const existing = await this.paymentsRepo.findByBakerAndCycle(
      bakerId,
      cycle,
    );

    if (existing.length === 0) {
      // Create new payment record
      await this.paymentsRepo.create({
        bakerId,
        cycle,
        date: new Date().toISOString(),
        result: PaymentStatus.REWARDS_PENDING,
        total: 0,
      });

      this.logger.log(`Created pending payment record for cycle ${cycle}`);
    } else {
      this.logger.debug(`Payment record already exists for cycle ${cycle}`);
    }
  }

  /**
   * Mark previous cycle as "rewards_delivered"
   * Based on BUSINESS_LOGIC.md Section 1.1 Step 1
   */
  async markCycleDelivered(
    bakerId: string,
    cycle: number,
  ): Promise<void> {
    this.logger.log(
      `Marking cycle ${cycle} as delivered for baker ${bakerId}`,
    );

    const payments = await this.paymentsRepo.findByBakerAndCycle(
      bakerId,
      cycle,
    );

    for (const payment of payments) {
      if (payment.isPending()) {
        await this.paymentsRepo.update(payment.id, {
          result: PaymentStatus.REWARDS_DELIVERED,
        });
      }
    }
  }

  /**
   * Check if rewards are available from blockchain
   * Tezos releases rewards after CYCLES_UNTIL_DELIVERED cycles
   *
   * @param cycle Cycle to check
   * @param currentCycle Current blockchain cycle
   * @returns true if rewards are available
   */
  async areRewardsAvailable(
    cycle: number,
    currentCycle?: number,
  ): Promise<boolean> {
    if (!currentCycle) {
      currentCycle = await this.tezosClient.getCurrentCycle();
    }

    // Rewards for cycle N become available at cycle N + CYCLES_UNTIL_DELIVERED
    const availableAtCycle = cycle + CYCLES_UNTIL_DELIVERED;

    const available = currentCycle >= availableAtCycle;

    this.logger.log(
      `Rewards for cycle ${cycle} available: ${available} (current: ${currentCycle}, needed: ${availableAtCycle})`,
    );

    return available;
  }

  /**
   * Get cycles that are ready for distribution
   * Returns cycles where rewards are delivered but not yet paid
   */
  async getCyclesReadyForDistribution(
    bakerId: string,
  ): Promise<PaymentEntity[]> {
    const payments = await this.paymentsRepo.findByStatus(
      PaymentStatus.REWARDS_DELIVERED,
    );

    // Filter by baker
    return payments.filter((p) => p.bakerId === bakerId);
  }

  /**
   * Initialize payment tracking for a new baker
   * Creates the first payment record
   */
  async initializePaymentTracking(bakerId: string): Promise<void> {
    this.logger.log(`Initializing payment tracking for baker ${bakerId}`);

    // Check if any payments exist
    const existing = await this.paymentsRepo.findByBakerId(bakerId);

    if (existing.length === 0) {
      // Get current cycle and calculate pending rewards cycle
      const cycleChange = await this.detectCycleChange(bakerId);

      if (cycleChange.pendingRewardsCycle !== null) {
        await this.markCyclePending(bakerId, cycleChange.pendingRewardsCycle);
        this.logger.log(
          `Initialized with cycle ${cycleChange.pendingRewardsCycle}`,
        );
      } else {
        this.logger.warn(
          'Cannot initialize - no rewards cycle available yet',
        );
      }
    } else {
      this.logger.debug(
        `Payment tracking already initialized (${existing.length} records)`,
      );
    }
  }

  /**
   * Update cycle tracking
   * Implements the cycle change workflow from BUSINESS_LOGIC.md
   *
   * Steps:
   * 1. Detect if cycle has changed
   * 2. Mark old cycle as delivered
   * 3. Create new pending cycle
   */
  async updateCycleTracking(bakerId: string): Promise<CycleChangeResult> {
    this.logger.log(`Updating cycle tracking for baker ${bakerId}`);

    // Step 1: Detect cycle change
    const cycleChange = await this.detectCycleChange(bakerId);

    if (cycleChange.changed && cycleChange.previousCycle !== null) {
      this.logger.log(
        `Cycle changed from ${cycleChange.previousCycle} to ${cycleChange.currentCycle}`,
      );

      // Step 2: Mark old cycle as delivered
      await this.markCycleDelivered(bakerId, cycleChange.previousCycle);

      // Step 3: Create new pending cycle if rewards are available
      if (cycleChange.pendingRewardsCycle !== null) {
        await this.markCyclePending(bakerId, cycleChange.pendingRewardsCycle);
      }
    } else {
      this.logger.debug('No cycle change detected');
    }

    return cycleChange;
  }

  /**
   * Get cycle information summary
   */
  async getCycleSummary(bakerId: string): Promise<{
    currentCycle: number;
    pendingRewardsCycle: number | null;
    lastProcessedCycle: number | null;
    cyclesReadyForDistribution: number;
  }> {
    const cycleChange = await this.detectCycleChange(bakerId);
    const readyCycles = await this.getCyclesReadyForDistribution(bakerId);
    const latestPayment = await this.paymentsRepo.findLatest(bakerId);

    return {
      currentCycle: cycleChange.currentCycle,
      pendingRewardsCycle: cycleChange.pendingRewardsCycle,
      lastProcessedCycle: latestPayment?.cycle || null,
      cyclesReadyForDistribution: readyCycles.length,
    };
  }
}
