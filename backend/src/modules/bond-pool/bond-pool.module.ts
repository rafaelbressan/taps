import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { BondPoolService } from './services/bond-pool.service';

/**
 * Bond Pool module
 * Handles bond pool reward distribution
 */
@Module({
  imports: [DatabaseModule],
  providers: [BondPoolService],
  exports: [BondPoolService],
})
export class BondPoolModule {}
