import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  Min,
  Max,
  IsBoolean,
} from 'class-validator';

/**
 * Operation mode enum
 */
export enum OperationMode {
  OFF = 'off',
  SIMULATION = 'simulation',
  ON = 'on',
}

/**
 * Update settings DTO
 */
export class UpdateSettingsDto {
  @ApiPropertyOptional({ description: 'Default fee percentage (0-100)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  defaultFee?: number;

  @ApiPropertyOptional({ description: 'Operation mode', enum: OperationMode })
  @IsOptional()
  @IsEnum(OperationMode)
  mode?: OperationMode;

  @ApiPropertyOptional({ description: 'Administrator charge percentage for bond pool' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  admCharge?: number;

  @ApiPropertyOptional({ description: 'Minimum payment amount in XTZ' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  minPayment?: number;

  @ApiPropertyOptional({ description: 'Whether to override delegator fees' })
  @IsOptional()
  @IsBoolean()
  overDel?: boolean;

  @ApiPropertyOptional({ description: 'Email address for notifications' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ description: 'Notification settings (JSON string)' })
  @IsOptional()
  @IsString()
  notificationSettings?: string;
}

/**
 * Update mode DTO
 */
export class UpdateModeDto {
  @ApiProperty({ description: 'Operation mode', enum: OperationMode })
  @IsEnum(OperationMode)
  mode!: OperationMode;
}

/**
 * Settings response
 */
export class SettingsResponse {
  @ApiProperty()
  baker_id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  default_fee!: number;

  @ApiProperty({ enum: OperationMode })
  mode!: OperationMode;

  @ApiProperty()
  adm_charge!: number;

  @ApiProperty()
  min_payment!: number;

  @ApiProperty()
  over_del!: boolean;

  @ApiPropertyOptional()
  email?: string | null;

  @ApiProperty()
  has_wallet!: boolean;

  @ApiProperty()
  created_at!: Date;

  @ApiProperty()
  updated_at!: Date;
}

/**
 * System status response
 */
export class SystemStatusResponse {
  @ApiProperty({ description: 'Current operation mode', enum: OperationMode })
  mode!: OperationMode;

  @ApiProperty({ description: 'Current Tezos cycle number' })
  current_cycle!: number;

  @ApiProperty({ description: 'Next cycle to be paid' })
  pending_cycle!: number;

  @ApiProperty({ description: 'Total delegators count' })
  total_delegators!: number;

  @ApiProperty({ description: 'Total active delegators (with balance)' })
  active_delegators!: number;

  @ApiProperty({ description: 'Baker address' })
  baker_address!: string;

  @ApiProperty({ description: 'Baker balance in XTZ' })
  baker_balance!: number;

  @ApiProperty({ description: 'Total rewards paid (all time) in XTZ' })
  total_rewards_paid!: number;

  @ApiProperty({ description: 'Whether bond pool is enabled' })
  bond_pool_enabled!: boolean;

  @ApiProperty({ description: 'Last successful payment date' })
  last_payment_date?: Date | null;

  @ApiProperty({ description: 'System health status' })
  health_status!: 'healthy' | 'warning' | 'error';
}
