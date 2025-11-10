import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PaymentEntity } from '../../shared/entities';
import {
  CreatePaymentDto,
  UpdatePaymentDto,
  QueryPaymentDto,
} from '../../shared/dto';
import { Prisma } from '@prisma/client';
import { PaymentStatus } from '../../shared/constants';

/**
 * Repository for Payment operations
 */
@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new payment
   */
  async create(data: CreatePaymentDto): Promise<PaymentEntity> {
    const payment = await this.prisma.payment.create({
      data: {
        bakerId: data.bakerId,
        cycle: data.cycle,
        date: new Date(data.date),
        result: data.result as any,
        total: new Prisma.Decimal(data.total),
        transactionHash: data.transactionHash,
      },
    });

    return new PaymentEntity(payment);
  }

  /**
   * Find payment by ID
   */
  async findById(id: number): Promise<PaymentEntity | null> {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
    });

    return payment ? new PaymentEntity(payment) : null;
  }

  /**
   * Find payment by baker ID and cycle
   */
  async findByBakerAndCycle(
    bakerId: string,
    cycle: number,
  ): Promise<PaymentEntity[]> {
    const payments = await this.prisma.payment.findMany({
      where: {
        bakerId,
        cycle,
      },
      orderBy: { date: 'desc' },
    });

    return payments.map((p) => new PaymentEntity(p));
  }

  /**
   * Find payments with query filters
   */
  async findMany(query: QueryPaymentDto): Promise<PaymentEntity[]> {
    const where: Prisma.PaymentWhereInput = {};

    if (query.bakerId) {
      where.bakerId = query.bakerId;
    }

    if (query.cycle !== undefined) {
      where.cycle = query.cycle;
    }

    if (query.result) {
      where.result = query.result as any;
    }

    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) {
        where.date.gte = new Date(query.dateFrom);
      }
      if (query.dateTo) {
        where.date.lte = new Date(query.dateTo);
      }
    }

    const payments = await this.prisma.payment.findMany({
      where,
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
      take: query.limit,
      skip: query.offset,
    });

    return payments.map((p) => new PaymentEntity(p));
  }

  /**
   * Find payments by baker ID
   */
  async findByBakerId(bakerId: string): Promise<PaymentEntity[]> {
    const payments = await this.prisma.payment.findMany({
      where: { bakerId },
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
    });

    return payments.map((p) => new PaymentEntity(p));
  }

  /**
   * Find payments by status
   */
  async findByStatus(status: PaymentStatus): Promise<PaymentEntity[]> {
    const payments = await this.prisma.payment.findMany({
      where: { result: status as any },
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
    });

    return payments.map((p) => new PaymentEntity(p));
  }

  /**
   * Find pending payments (rewards_pending)
   */
  async findPending(): Promise<PaymentEntity[]> {
    return this.findByStatus(PaymentStatus.REWARDS_PENDING);
  }

  /**
   * Find payments with delivered rewards (rewards_delivered)
   */
  async findRewardsDelivered(): Promise<PaymentEntity[]> {
    return this.findByStatus(PaymentStatus.REWARDS_DELIVERED);
  }

  /**
   * Find payments with errors
   */
  async findErrors(): Promise<PaymentEntity[]> {
    return this.findByStatus(PaymentStatus.ERRORS);
  }

  /**
   * Update payment
   */
  async update(id: number, data: UpdatePaymentDto): Promise<PaymentEntity> {
    const updateData: Prisma.PaymentUpdateInput = {};

    if (data.result !== undefined) {
      updateData.result = data.result as any;
    }

    if (data.total !== undefined) {
      updateData.total = new Prisma.Decimal(data.total);
    }

    if (data.transactionHash !== undefined) {
      updateData.transactionHash = data.transactionHash;
    }

    const payment = await this.prisma.payment.update({
      where: { id },
      data: updateData,
    });

    return new PaymentEntity(payment);
  }

  /**
   * Delete payment
   */
  async delete(id: number): Promise<void> {
    await this.prisma.payment.delete({
      where: { id },
    });
  }

  /**
   * Get total payment amount by baker and cycle
   */
  async getTotalByBakerAndCycle(
    bakerId: string,
    cycle: number,
  ): Promise<number> {
    const result = await this.prisma.payment.aggregate({
      where: {
        bakerId,
        cycle,
        result: PaymentStatus.PAID as any,
      },
      _sum: {
        total: true,
      },
    });

    return result._sum.total?.toNumber() ?? 0;
  }

  /**
   * Count payments by status
   */
  async countByStatus(bakerId: string, status: PaymentStatus): Promise<number> {
    return this.prisma.payment.count({
      where: {
        bakerId,
        result: status as any,
      },
    });
  }

  /**
   * Get latest payment for a baker
   */
  async findLatest(bakerId: string): Promise<PaymentEntity | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { bakerId },
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
    });

    return payment ? new PaymentEntity(payment) : null;
  }

  /**
   * Get payments by cycle range
   */
  async findByCycleRange(
    bakerId: string,
    fromCycle: number,
    toCycle: number,
  ): Promise<PaymentEntity[]> {
    const payments = await this.prisma.payment.findMany({
      where: {
        bakerId,
        cycle: {
          gte: fromCycle,
          lte: toCycle,
        },
      },
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
    });

    return payments.map((p) => new PaymentEntity(p));
  }
}
