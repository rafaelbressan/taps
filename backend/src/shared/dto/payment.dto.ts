import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { z } from 'zod';
import { PaymentStatus } from '../constants';

/**
 * DTO for creating Payment
 */
export class CreatePaymentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  bakerId!: string;

  @IsNumber()
  @Min(0)
  cycle!: number;

  @IsDateString()
  date!: string;

  @IsEnum(PaymentStatus)
  result!: PaymentStatus;

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
 * DTO for updating Payment
 */
export class UpdatePaymentDto {
  @IsEnum(PaymentStatus)
  @IsOptional()
  result?: PaymentStatus;

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
 * DTO for querying Payments
 */
export class QueryPaymentDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  bakerId?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  cycle?: number;

  @IsEnum(PaymentStatus)
  @IsOptional()
  result?: PaymentStatus;

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
 * Zod schemas for runtime validation
 */
export const CreatePaymentSchema = z.object({
  bakerId: z.string().min(1).max(50),
  cycle: z.number().int().min(0),
  date: z.string().datetime().or(z.date()),
  result: z.enum([
    'rewards_pending',
    'rewards_delivered',
    'paid',
    'simulated',
    'errors',
  ]),
  total: z.number().min(0),
  transactionHash: z.string().min(46).max(70).optional(),
});

export const UpdatePaymentSchema = z.object({
  result: z
    .enum(['rewards_pending', 'rewards_delivered', 'paid', 'simulated', 'errors'])
    .optional(),
  total: z.number().min(0).optional(),
  transactionHash: z.string().min(46).max(70).optional(),
});

export const QueryPaymentSchema = z.object({
  bakerId: z.string().max(50).optional(),
  cycle: z.number().int().min(0).optional(),
  result: z
    .enum(['rewards_pending', 'rewards_delivered', 'paid', 'simulated', 'errors'])
    .optional(),
  dateFrom: z.string().datetime().or(z.date()).optional(),
  dateTo: z.string().datetime().or(z.date()).optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof UpdatePaymentSchema>;
export type QueryPaymentInput = z.infer<typeof QueryPaymentSchema>;
