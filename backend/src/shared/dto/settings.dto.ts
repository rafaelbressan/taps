import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsUrl,
  IsPort,
} from 'class-validator';
import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { OperationMode } from '../constants';

/**
 * DTO for creating Settings
 */
export class CreateSettingsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  bakerId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  defaultFee!: number;

  @IsNumber()
  @Min(1)
  updateFreq!: number;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  userName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  passHash?: string;

  @IsPort()
  applicationPort!: number;

  @IsEnum(OperationMode)
  @IsOptional()
  mode?: OperationMode;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  hashSalt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  walletHash?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  walletSalt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  encryptedPassphrase?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  appPassphrase?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  delegate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(70)
  proxyServer?: string;

  @IsPort()
  @IsOptional()
  proxyPort?: number;

  @IsString()
  @MaxLength(70)
  provider!: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  gasLimit?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  storageLimit?: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @IsOptional()
  transactionFee?: number;

  @IsString()
  @MaxLength(70)
  blockExplorer!: string;

  @IsNumber()
  @Min(1)
  @IsOptional()
  numBlocksWait?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  paymentRetries?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  minBetweenRetries?: number;
}

/**
 * DTO for updating Settings
 */
export class UpdateSettingsDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  defaultFee?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  updateFreq?: number;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  userName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  passHash?: string;

  @IsPort()
  @IsOptional()
  applicationPort?: number;

  @IsEnum(OperationMode)
  @IsOptional()
  mode?: OperationMode;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  hashSalt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  walletHash?: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  walletSalt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  encryptedPassphrase?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  appPassphrase?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  delegate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(70)
  proxyServer?: string;

  @IsPort()
  @IsOptional()
  proxyPort?: number;

  @IsString()
  @MaxLength(70)
  @IsOptional()
  provider?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  gasLimit?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  storageLimit?: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @IsOptional()
  transactionFee?: number;

  @IsString()
  @MaxLength(70)
  @IsOptional()
  blockExplorer?: string;

  @IsNumber()
  @Min(1)
  @IsOptional()
  numBlocksWait?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  paymentRetries?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  minBetweenRetries?: number;
}

/**
 * Zod schemas for runtime validation
 */
export const CreateSettingsSchema = z.object({
  bakerId: z.string().min(1).max(50),
  defaultFee: z.number().min(0).max(100),
  updateFreq: z.number().int().min(1),
  userName: z.string().max(100).optional(),
  passHash: z.string().max(150).optional(),
  applicationPort: z.number().int().min(1).max(65535),
  mode: z.enum(['off', 'simulation', 'on']).optional(),
  hashSalt: z.string().max(150).optional(),
  walletHash: z.string().max(150).optional(),
  walletSalt: z.string().max(150).optional(),
  encryptedPassphrase: z.string().max(255).optional(),
  appPassphrase: z.string().max(255).optional(),
  delegate: z.string().max(50).optional(),
  proxyServer: z.string().max(70).optional(),
  proxyPort: z.number().int().min(1).max(65535).optional(),
  provider: z.string().max(70),
  gasLimit: z.number().int().min(0).optional(),
  storageLimit: z.number().int().min(0).optional(),
  transactionFee: z.number().min(0).optional(),
  blockExplorer: z.string().max(70),
  numBlocksWait: z.number().int().min(1).optional(),
  paymentRetries: z.number().int().min(0).optional(),
  minBetweenRetries: z.number().int().min(0).optional(),
});

export const UpdateSettingsSchema = z.object({
  defaultFee: z.number().min(0).max(100).optional(),
  updateFreq: z.number().int().min(1).optional(),
  userName: z.string().max(100).optional(),
  passHash: z.string().max(150).optional(),
  applicationPort: z.number().int().min(1).max(65535).optional(),
  mode: z.enum(['off', 'simulation', 'on']).optional(),
  hashSalt: z.string().max(150).optional(),
  walletHash: z.string().max(150).optional(),
  walletSalt: z.string().max(150).optional(),
  encryptedPassphrase: z.string().max(255).optional(),
  appPassphrase: z.string().max(255).optional(),
  delegate: z.string().max(50).optional(),
  proxyServer: z.string().max(70).optional(),
  proxyPort: z.number().int().min(1).max(65535).optional(),
  provider: z.string().max(70).optional(),
  gasLimit: z.number().int().min(0).optional(),
  storageLimit: z.number().int().min(0).optional(),
  transactionFee: z.number().min(0).optional(),
  blockExplorer: z.string().max(70).optional(),
  numBlocksWait: z.number().int().min(1).optional(),
  paymentRetries: z.number().int().min(0).optional(),
  minBetweenRetries: z.number().int().min(0).optional(),
});

export type CreateSettingsInput = z.infer<typeof CreateSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
