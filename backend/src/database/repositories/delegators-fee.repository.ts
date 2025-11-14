import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DelegatorFeeEntity } from '../../shared/entities';
import {
  CreateDelegatorFeeDto,
  UpdateDelegatorFeeDto,
  QueryDelegatorFeeDto,
} from '../../shared/dto';
import { Prisma } from '@prisma/client';

/**
 * Repository for DelegatorFee operations
 */
@Injectable()
export class DelegatorsFeeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new delegator fee
   */
  async create(data: CreateDelegatorFeeDto): Promise<DelegatorFeeEntity> {
    const fee = await this.prisma.delegatorFee.create({
      data: {
        bakerId: data.bakerId,
        address: data.address,
        fee: new Prisma.Decimal(data.fee),
      },
    });

    return new DelegatorFeeEntity(fee);
  }

  /**
   * Find delegator fee by baker ID and address
   */
  async findByBakerAndAddress(
    bakerId: string,
    address: string,
  ): Promise<DelegatorFeeEntity | null> {
    const fee = await this.prisma.delegatorFee.findUnique({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
    });

    return fee ? new DelegatorFeeEntity(fee) : null;
  }

  /**
   * Find all fees for a baker
   */
  async findByBakerId(bakerId: string): Promise<DelegatorFeeEntity[]> {
    const fees = await this.prisma.delegatorFee.findMany({
      where: { bakerId },
      orderBy: { address: 'asc' },
    });

    return fees.map((f) => new DelegatorFeeEntity(f));
  }

  /**
   * Find all fees for an address across all bakers
   */
  async findByAddress(address: string): Promise<DelegatorFeeEntity[]> {
    const fees = await this.prisma.delegatorFee.findMany({
      where: { address },
      orderBy: { bakerId: 'asc' },
    });

    return fees.map((f) => new DelegatorFeeEntity(f));
  }

  /**
   * Find fees with query filters
   */
  async findMany(query: QueryDelegatorFeeDto): Promise<DelegatorFeeEntity[]> {
    const where: Prisma.DelegatorFeeWhereInput = {};

    if (query.bakerId) {
      where.bakerId = query.bakerId;
    }

    if (query.address) {
      where.address = query.address;
    }

    const fees = await this.prisma.delegatorFee.findMany({
      where,
      orderBy: { address: 'asc' },
      take: query.limit,
      skip: query.offset,
    });

    return fees.map((f) => new DelegatorFeeEntity(f));
  }

  /**
   * Update delegator fee
   */
  async update(
    bakerId: string,
    address: string,
    data: UpdateDelegatorFeeDto,
  ): Promise<DelegatorFeeEntity> {
    const fee = await this.prisma.delegatorFee.update({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
      data: {
        fee: new Prisma.Decimal(data.fee),
      },
    });

    return new DelegatorFeeEntity(fee);
  }

  /**
   * Upsert delegator fee (create if not exists, update if exists)
   */
  async upsert(
    bakerId: string,
    address: string,
    fee: number,
  ): Promise<DelegatorFeeEntity> {
    const result = await this.prisma.delegatorFee.upsert({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
      create: {
        bakerId,
        address,
        fee: new Prisma.Decimal(fee),
      },
      update: {
        fee: new Prisma.Decimal(fee),
      },
    });

    return new DelegatorFeeEntity(result);
  }

  /**
   * Delete delegator fee
   */
  async delete(bakerId: string, address: string): Promise<void> {
    await this.prisma.delegatorFee.delete({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
    });
  }

  /**
   * Check if delegator has custom fee
   */
  async exists(bakerId: string, address: string): Promise<boolean> {
    const count = await this.prisma.delegatorFee.count({
      where: {
        bakerId,
        address,
      },
    });

    return count > 0;
  }

  /**
   * Count total custom fees for a baker
   */
  async countByBaker(bakerId: string): Promise<number> {
    return this.prisma.delegatorFee.count({
      where: { bakerId },
    });
  }

  /**
   * Get fee for delegator (returns custom fee or default)
   */
  async getFeeForDelegator(
    bakerId: string,
    address: string,
    defaultFee: number,
  ): Promise<number> {
    const customFee = await this.findByBakerAndAddress(bakerId, address);

    if (customFee) {
      return customFee.getFeePercentage();
    }

    return defaultFee;
  }

  /**
   * Bulk create delegator fees
   */
  async createMany(data: CreateDelegatorFeeDto[]): Promise<number> {
    const result = await this.prisma.delegatorFee.createMany({
      data: data.map((d) => ({
        bakerId: d.bakerId,
        address: d.address,
        fee: new Prisma.Decimal(d.fee),
      })),
      skipDuplicates: true,
    });

    return result.count;
  }

  /**
   * Delete all fees for a baker
   */
  async deleteAllByBaker(bakerId: string): Promise<number> {
    const result = await this.prisma.delegatorFee.deleteMany({
      where: { bakerId },
    });

    return result.count;
  }
}
