import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DelegatorPaymentEntity } from '../../shared/entities';
import {
  CreateDelegatorPaymentDto,
  UpdateDelegatorPaymentDto,
  QueryDelegatorPaymentDto,
} from '../../shared/dto';
import { Prisma } from '@prisma/client';
import { DelegatorPaymentStatus } from '../../shared/constants';

/**
 * Repository for DelegatorPayment operations
 */
@Injectable()
export class DelegatorsPaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new delegator payment
   */
  async create(data: CreateDelegatorPaymentDto): Promise<DelegatorPaymentEntity> {
    const payment = await this.prisma.delegatorPayment.create({
      data: {
        bakerId: data.bakerId,
        cycle: data.cycle,
        address: data.address,
        date: new Date(data.date),
        result: data.result as any,
        total: new Prisma.Decimal(data.total),
        transactionHash: data.transactionHash,
      },
    });

    return new DelegatorPaymentEntity(payment);
  }

  /**
   * Find delegator payment by ID
   */
  async findById(id: number): Promise<DelegatorPaymentEntity | null> {
    const payment = await this.prisma.delegatorPayment.findUnique({
      where: { id },
    });

    return payment ? new DelegatorPaymentEntity(payment) : null;
  }

  /**
   * Find delegator payments with query filters
   */
  async findMany(
    query: QueryDelegatorPaymentDto,
  ): Promise<DelegatorPaymentEntity[]> {
    const where: Prisma.DelegatorPaymentWhereInput = {};

    if (query.bakerId) {
      where.bakerId = query.bakerId;
    }

    if (query.cycle !== undefined) {
      where.cycle = query.cycle;
    }

    if (query.address) {
      where.address = query.address;
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

    const payments = await this.prisma.delegatorPayment.findMany({
      where,
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
      take: query.limit,
      skip: query.offset,
    });

    return payments.map((p) => new DelegatorPaymentEntity(p));
  }

  /**
   * Find payments by baker and cycle
   */
  async findByBakerAndCycle(
    bakerId: string,
    cycle: number,
  ): Promise<DelegatorPaymentEntity[]> {
    const payments = await this.prisma.delegatorPayment.findMany({
      where: {
        bakerId,
        cycle,
      },
      orderBy: { address: 'asc' },
    });

    return payments.map((p) => new DelegatorPaymentEntity(p));
  }

  /**
   * Find payments by delegator address
   */
  async findByAddress(address: string): Promise<DelegatorPaymentEntity[]> {
    const payments = await this.prisma.delegatorPayment.findMany({
      where: { address },
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
    });

    return payments.map((p) => new DelegatorPaymentEntity(p));
  }

  /**
   * Find payments by baker, cycle, and address
   */
  async findByBakerCycleAndAddress(
    bakerId: string,
    cycle: number,
    address: string,
  ): Promise<DelegatorPaymentEntity[]> {
    const payments = await this.prisma.delegatorPayment.findMany({
      where: {
        bakerId,
        cycle,
        address,
      },
      orderBy: { date: 'desc' },
    });

    return payments.map((p) => new DelegatorPaymentEntity(p));
  }

  /**
   * Find payments by status
   */
  async findByStatus(
    status: DelegatorPaymentStatus,
  ): Promise<DelegatorPaymentEntity[]> {
    const payments = await this.prisma.delegatorPayment.findMany({
      where: { result: status as any },
      orderBy: [{ cycle: 'desc' }, { date: 'desc' }],
    });

    return payments.map((p) => new DelegatorPaymentEntity(p));
  }

  /**
   * Find failed payments
   */
  async findFailed(): Promise<DelegatorPaymentEntity[]> {
    return this.findByStatus(DelegatorPaymentStatus.FAILED);
  }

  /**
   * Find applied payments for a cycle
   */
  async findAppliedByCycle(cycle: number): Promise<DelegatorPaymentEntity[]> {
    const payments = await this.prisma.delegatorPayment.findMany({
      where: {
        cycle,
        result: DelegatorPaymentStatus.APPLIED as any,
      },
      orderBy: { address: 'asc' },
    });

    return payments.map((p) => new DelegatorPaymentEntity(p));
  }

  /**
   * Update delegator payment
   */
  async update(
    id: number,
    data: UpdateDelegatorPaymentDto,
  ): Promise<DelegatorPaymentEntity> {
    const updateData: Prisma.DelegatorPaymentUpdateInput = {};

    if (data.result !== undefined) {
      updateData.result = data.result as any;
    }

    if (data.total !== undefined) {
      updateData.total = new Prisma.Decimal(data.total);
    }

    if (data.transactionHash !== undefined) {
      updateData.transactionHash = data.transactionHash;
    }

    const payment = await this.prisma.delegatorPayment.update({
      where: { id },
      data: updateData,
    });

    return new DelegatorPaymentEntity(payment);
  }

  /**
   * Delete delegator payment
   */
  async delete(id: number): Promise<void> {
    await this.prisma.delegatorPayment.delete({
      where: { id },
    });
  }

  /**
   * Get total payments amount by baker and cycle
   */
  async getTotalByBakerAndCycle(
    bakerId: string,
    cycle: number,
  ): Promise<number> {
    const result = await this.prisma.delegatorPayment.aggregate({
      where: {
        bakerId,
        cycle,
        result: DelegatorPaymentStatus.APPLIED as any,
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
  async countByStatus(
    bakerId: string,
    cycle: number,
    status: DelegatorPaymentStatus,
  ): Promise<number> {
    return this.prisma.delegatorPayment.count({
      where: {
        bakerId,
        cycle,
        result: status as any,
      },
    });
  }

  /**
   * Get unique delegators for a baker and cycle
   */
  async getUniqueDelegators(
    bakerId: string,
    cycle: number,
  ): Promise<string[]> {
    const payments = await this.prisma.delegatorPayment.findMany({
      where: {
        bakerId,
        cycle,
      },
      select: {
        address: true,
      },
      distinct: ['address'],
    });

    return payments.map((p) => p.address);
  }

  /**
   * Bulk create delegator payments
   */
  async createMany(
    data: CreateDelegatorPaymentDto[],
  ): Promise<number> {
    const result = await this.prisma.delegatorPayment.createMany({
      data: data.map((d) => ({
        bakerId: d.bakerId,
        cycle: d.cycle,
        address: d.address,
        date: new Date(d.date),
        result: d.result as any,
        total: new Prisma.Decimal(d.total),
        transactionHash: d.transactionHash,
      })),
      skipDuplicates: true,
    });

    return result.count;
  }
}
