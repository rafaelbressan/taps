import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  MinLength,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { z } from 'zod';
import { DelegatorPaymentStatus } from '../constants';

/**
 * DTO for creating DelegatorPayment
 */
export class CreateDelegatorPaymentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  bakerId!: string;

  @IsNumber()
  @Min(0)
  cycle!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  address!: string;

  @IsDateString()
  date!: string;

  @IsEnum(DelegatorPaymentStatus)
  result!: DelegatorPaymentStatus;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  total!: number;

  @IsString()
  @IsOptional()
  @MinLength(46)
  @MaxLength(70)
  transactionHash?: string;
}

/**
 * DTO for updating DelegatorPayment
 */
export class UpdateDelegatorPaymentDto {
  @IsEnum(DelegatorPaymentStatus)
  @IsOptional()
  result?: DelegatorPaymentStatus;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @IsOptional()
  total?: number;

  @IsString()
  @IsOptional()
  @MinLength(46)
  @MaxLength(70)
  transactionHash?: string;
}

/**
 * DTO for querying DelegatorPayments
 */
export class QueryDelegatorPaymentDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  bakerId?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  cycle?: number;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  address?: string;

  @IsEnum(DelegatorPaymentStatus)
  @IsOptional()
  result?: DelegatorPaymentStatus;

  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @IsDateString()
  @IsOptional()
  dateTo?: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  offset?: number;
}

/**
 * DTO for creating DelegatorFee
 */
export class CreateDelegatorFeeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  bakerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  address!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  fee!: number;
}

/**
 * DTO for updating DelegatorFee
 */
export class UpdateDelegatorFeeDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  fee!: number;
}

/**
 * DTO for querying DelegatorFees
 */
export class QueryDelegatorFeeDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  bakerId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  address?: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  offset?: number;
}

/**
 * Zod schemas for runtime validation
 */
export const CreateDelegatorPaymentSchema = z.object({
  bakerId: z.string().min(1).max(50),
  cycle: z.number().int().min(0),
  address: z.string().min(1).max(50),
  date: z.string().datetime().or(z.date()),
  result: z.enum(['applied', 'simulated', 'failed', 'not_available']),
  total: z.number().min(0),
  transactionHash: z.string().min(46).max(70).optional(),
});

export const UpdateDelegatorPaymentSchema = z.object({
  result: z.enum(['applied', 'simulated', 'failed', 'not_available']).optional(),
  total: z.number().min(0).optional(),
  transactionHash: z.string().min(46).max(70).optional(),
});

export const QueryDelegatorPaymentSchema = z.object({
  bakerId: z.string().max(50).optional(),
  cycle: z.number().int().min(0).optional(),
  address: z.string().max(50).optional(),
  result: z.enum(['applied', 'simulated', 'failed', 'not_available']).optional(),
  dateFrom: z.string().datetime().or(z.date()).optional(),
  dateTo: z.string().datetime().or(z.date()).optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

export const CreateDelegatorFeeSchema = z.object({
  bakerId: z.string().min(1).max(50),
  address: z.string().min(1).max(50),
  fee: z.number().min(0).max(100),
});

export const UpdateDelegatorFeeSchema = z.object({
  fee: z.number().min(0).max(100),
});

export const QueryDelegatorFeeSchema = z.object({
  bakerId: z.string().max(50).optional(),
  address: z.string().max(50).optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

export type CreateDelegatorPaymentInput = z.infer<
  typeof CreateDelegatorPaymentSchema
>;
export type UpdateDelegatorPaymentInput = z.infer<
  typeof UpdateDelegatorPaymentSchema
>;
export type QueryDelegatorPaymentInput = z.infer<
  typeof QueryDelegatorPaymentSchema
>;
export type CreateDelegatorFeeInput = z.infer<typeof CreateDelegatorFeeSchema>;
export type UpdateDelegatorFeeInput = z.infer<typeof UpdateDelegatorFeeSchema>;
export type QueryDelegatorFeeInput = z.infer<typeof QueryDelegatorFeeSchema>;
