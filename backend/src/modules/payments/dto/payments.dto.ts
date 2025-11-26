import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  Min,
  Max,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Payment status enum
 */
export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
}

/**
 * Payment history query DTO
 */
export class PaymentHistoryQueryDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: PaymentStatus,
  })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ description: 'Filter by start date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Filter by end date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

/**
 * Payment response
 */
export class PaymentResponse {
  @ApiProperty()
  cycle!: number;

  @ApiProperty()
  date!: Date;

  @ApiProperty({ description: 'Gross rewards in XTZ' })
  gross_rewards!: number;

  @ApiProperty({ description: 'Net rewards (after fees) in XTZ' })
  net_rewards!: number;

  @ApiProperty({ description: 'Baker fee in XTZ' })
  baker_fee!: number;

  @ApiProperty({ description: 'Number of delegators paid' })
  delegators_count!: number;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiPropertyOptional({ description: 'Transaction hash (if paid)' })
  transaction_hash?: string | null;

  @ApiPropertyOptional({ description: 'Error message (if failed)' })
  error_message?: string | null;
}

/**
 * Paginated payment response
 */
export class PaginatedPaymentResponse {
  @ApiProperty({ type: [PaymentResponse] })
  data!: PaymentResponse[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total_pages!: number;
}

/**
 * Cycle payment response with delegator details
 */
export class CyclePaymentResponse {
  @ApiProperty()
  cycle!: number;

  @ApiProperty({ type: PaymentResponse })
  payment!: PaymentResponse;

  @ApiProperty()
  delegator_payments!: DelegatorPaymentDetail[];
}

/**
 * Delegator payment detail
 */
export class DelegatorPaymentDetail {
  @ApiProperty()
  address!: string;

  @ApiProperty({ description: 'Reward amount in XTZ' })
  amount!: number;

  @ApiProperty({ description: 'Fee percentage applied' })
  fee!: number;

  @ApiProperty({ description: 'Balance at time of snapshot in XTZ' })
  balance!: number;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiPropertyOptional()
  transaction_hash?: string | null;
}

/**
 * Distribution response
 */
export class DistributionResponse {
  @ApiProperty()
  cycle!: number;

  @ApiProperty({ description: 'Whether distribution was successful' })
  success!: boolean;

  @ApiProperty({ description: 'Number of delegators paid' })
  delegators_paid!: number;

  @ApiProperty({ description: 'Total amount distributed in XTZ' })
  total_distributed!: number;

  @ApiProperty({ description: 'Transaction hashes' })
  transaction_hashes!: string[];

  @ApiPropertyOptional({ description: 'Error message if failed' })
  error_message?: string;
}
