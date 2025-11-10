import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import {
  SettingsRepository,
  PaymentsRepository,
  DelegatorsPaymentsRepository,
  DelegatorsFeeRepository,
  BondPoolRepository,
} from './repositories';

/**
 * Global database module providing Prisma service and all repositories
 */
@Global()
@Module({
  providers: [
    PrismaService,
    SettingsRepository,
    PaymentsRepository,
    DelegatorsPaymentsRepository,
    DelegatorsFeeRepository,
    BondPoolRepository,
  ],
  exports: [
    PrismaService,
    SettingsRepository,
    PaymentsRepository,
    DelegatorsPaymentsRepository,
    DelegatorsFeeRepository,
    BondPoolRepository,
  ],
})
export class DatabaseModule {}
