import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { SettingsController } from './controllers/settings.controller';
import { SettingsService } from './services/settings.service';

@Module({
  imports: [DatabaseModule, BlockchainModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
