import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  BondPoolSettingsEntity,
  BondPoolMemberEntity,
} from '../../shared/entities';
import {
  CreateBondPoolSettingsDto,
  UpdateBondPoolSettingsDto,
  CreateBondPoolMemberDto,
  UpdateBondPoolMemberDto,
  QueryBondPoolMemberDto,
} from '../../shared/dto';
import { Prisma } from '@prisma/client';

/**
 * Repository for BondPool operations (Settings and Members)
 */
@Injectable()
export class BondPoolRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== BondPoolSettings Operations ====================

  /**
   * Create bond pool settings
   */
  async createSettings(
    data: CreateBondPoolSettingsDto,
  ): Promise<BondPoolSettingsEntity> {
    const settings = await this.prisma.bondPoolSettings.create({
      data: {
        bakerId: data.bakerId,
        status: data.status,
      },
    });

    return new BondPoolSettingsEntity(settings);
  }

  /**
   * Find bond pool settings by baker ID
   */
  async findSettingsByBakerId(
    bakerId: string,
  ): Promise<BondPoolSettingsEntity | null> {
    const settings = await this.prisma.bondPoolSettings.findUnique({
      where: { bakerId },
    });

    return settings ? new BondPoolSettingsEntity(settings) : null;
  }

  /**
   * Update bond pool settings
   */
  async updateSettings(
    bakerId: string,
    data: UpdateBondPoolSettingsDto,
  ): Promise<BondPoolSettingsEntity> {
    const settings = await this.prisma.bondPoolSettings.update({
      where: { bakerId },
      data: {
        status: data.status,
      },
    });

    return new BondPoolSettingsEntity(settings);
  }

  /**
   * Upsert bond pool settings
   */
  async upsertSettings(
    bakerId: string,
    status: boolean,
  ): Promise<BondPoolSettingsEntity> {
    const settings = await this.prisma.bondPoolSettings.upsert({
      where: { bakerId },
      create: {
        bakerId,
        status,
      },
      update: {
        status,
      },
    });

    return new BondPoolSettingsEntity(settings);
  }

  /**
   * Delete bond pool settings
   */
  async deleteSettings(bakerId: string): Promise<void> {
    await this.prisma.bondPoolSettings.delete({
      where: { bakerId },
    });
  }

  /**
   * Check if bond pool is enabled for a baker
   */
  async isBondPoolEnabled(bakerId: string): Promise<boolean> {
    const settings = await this.findSettingsByBakerId(bakerId);
    return settings?.isEnabled() ?? false;
  }

  // ==================== BondPoolMember Operations ====================

  /**
   * Create bond pool member
   */
  async createMember(
    data: CreateBondPoolMemberDto,
  ): Promise<BondPoolMemberEntity> {
    const member = await this.prisma.bondPoolMember.create({
      data: {
        bakerId: data.bakerId,
        address: data.address,
        amount: new Prisma.Decimal(data.amount),
        name: data.name,
        admCharge: new Prisma.Decimal(data.admCharge),
        isManager: data.isManager ?? false,
      },
    });

    return new BondPoolMemberEntity(member);
  }

  /**
   * Find bond pool member by baker ID and address
   */
  async findMemberByBakerAndAddress(
    bakerId: string,
    address: string,
  ): Promise<BondPoolMemberEntity | null> {
    const member = await this.prisma.bondPoolMember.findUnique({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
    });

    return member ? new BondPoolMemberEntity(member) : null;
  }

  /**
   * Find all members for a baker
   */
  async findMembersByBakerId(bakerId: string): Promise<BondPoolMemberEntity[]> {
    const members = await this.prisma.bondPoolMember.findMany({
      where: { bakerId },
      orderBy: { amount: 'desc' },
    });

    return members.map((m) => new BondPoolMemberEntity(m));
  }

  /**
   * Find members with query filters
   */
  async findMembers(
    query: QueryBondPoolMemberDto,
  ): Promise<BondPoolMemberEntity[]> {
    const where: Prisma.BondPoolMemberWhereInput = {};

    if (query.bakerId) {
      where.bakerId = query.bakerId;
    }

    if (query.address) {
      where.address = query.address;
    }

    if (query.isManager !== undefined) {
      where.isManager = query.isManager;
    }

    const members = await this.prisma.bondPoolMember.findMany({
      where,
      orderBy: { amount: 'desc' },
      take: query.limit,
      skip: query.offset,
    });

    return members.map((m) => new BondPoolMemberEntity(m));
  }

  /**
   * Find pool managers for a baker
   */
  async findManagersByBakerId(bakerId: string): Promise<BondPoolMemberEntity[]> {
    const members = await this.prisma.bondPoolMember.findMany({
      where: {
        bakerId,
        isManager: true,
      },
      orderBy: { amount: 'desc' },
    });

    return members.map((m) => new BondPoolMemberEntity(m));
  }

  /**
   * Update bond pool member
   */
  async updateMember(
    bakerId: string,
    address: string,
    data: UpdateBondPoolMemberDto,
  ): Promise<BondPoolMemberEntity> {
    const updateData: Prisma.BondPoolMemberUpdateInput = {};

    if (data.amount !== undefined) {
      updateData.amount = new Prisma.Decimal(data.amount);
    }

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.admCharge !== undefined) {
      updateData.admCharge = new Prisma.Decimal(data.admCharge);
    }

    if (data.isManager !== undefined) {
      updateData.isManager = data.isManager;
    }

    const member = await this.prisma.bondPoolMember.update({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
      data: updateData,
    });

    return new BondPoolMemberEntity(member);
  }

  /**
   * Upsert bond pool member
   */
  async upsertMember(
    data: CreateBondPoolMemberDto,
  ): Promise<BondPoolMemberEntity> {
    const member = await this.prisma.bondPoolMember.upsert({
      where: {
        bakerId_address: {
          bakerId: data.bakerId,
          address: data.address,
        },
      },
      create: {
        bakerId: data.bakerId,
        address: data.address,
        amount: new Prisma.Decimal(data.amount),
        name: data.name,
        admCharge: new Prisma.Decimal(data.admCharge),
        isManager: data.isManager ?? false,
      },
      update: {
        amount: new Prisma.Decimal(data.amount),
        name: data.name,
        admCharge: new Prisma.Decimal(data.admCharge),
        isManager: data.isManager,
      },
    });

    return new BondPoolMemberEntity(member);
  }

  /**
   * Delete bond pool member
   */
  async deleteMember(bakerId: string, address: string): Promise<void> {
    await this.prisma.bondPoolMember.delete({
      where: {
        bakerId_address: {
          bakerId,
          address,
        },
      },
    });
  }

  /**
   * Get total pool amount for a baker
   */
  async getTotalPoolAmount(bakerId: string): Promise<number> {
    const result = await this.prisma.bondPoolMember.aggregate({
      where: { bakerId },
      _sum: {
        amount: true,
      },
    });

    return result._sum.amount?.toNumber() ?? 0;
  }

  /**
   * Get total administrative charges for a baker
   */
  async getTotalAdmCharges(bakerId: string): Promise<number> {
    const result = await this.prisma.bondPoolMember.aggregate({
      where: { bakerId },
      _sum: {
        admCharge: true,
      },
    });

    return result._sum.admCharge?.toNumber() ?? 0;
  }

  /**
   * Count bond pool members for a baker
   */
  async countMembers(bakerId: string): Promise<number> {
    return this.prisma.bondPoolMember.count({
      where: { bakerId },
    });
  }

  /**
   * Count managers for a baker
   */
  async countManagers(bakerId: string): Promise<number> {
    return this.prisma.bondPoolMember.count({
      where: {
        bakerId,
        isManager: true,
      },
    });
  }

  /**
   * Bulk create bond pool members
   */
  async createManyMembers(data: CreateBondPoolMemberDto[]): Promise<number> {
    const result = await this.prisma.bondPoolMember.createMany({
      data: data.map((d) => ({
        bakerId: d.bakerId,
        address: d.address,
        amount: new Prisma.Decimal(d.amount),
        name: d.name,
        admCharge: new Prisma.Decimal(d.admCharge),
        isManager: d.isManager ?? false,
      })),
      skipDuplicates: true,
    });

    return result.count;
  }

  /**
   * Delete all members for a baker
   */
  async deleteAllMembers(bakerId: string): Promise<number> {
    const result = await this.prisma.bondPoolMember.deleteMany({
      where: { bakerId },
    });

    return result.count;
  }
}
