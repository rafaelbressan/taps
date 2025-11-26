import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { RewardsModule } from '../rewards/rewards.module';
import { PaymentsController } from './controllers/payments.controller';

@Module({
  imports: [DatabaseModule, RewardsModule],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
