import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { z } from 'zod';

/**
 * DTO for creating BondPoolSettings
 */
export class CreateBondPoolSettingsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  bakerId!: string;

  @IsBoolean()
  status!: boolean;
}

/**
 * DTO for updating BondPoolSettings
 */
export class UpdateBondPoolSettingsDto {
  @IsBoolean()
  status!: boolean;
}

/**
 * DTO for creating BondPoolMember
 */
export class CreateBondPoolMemberDto {
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
  amount!: number;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  name?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  admCharge!: number;

  @IsBoolean()
  @IsOptional()
  isManager?: boolean;
}

/**
 * DTO for updating BondPoolMember
 */
export class UpdateBondPoolMemberDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  amount?: number;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  name?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  admCharge?: number;

  @IsBoolean()
  @IsOptional()
  isManager?: boolean;
}

/**
 * DTO for querying BondPoolMembers
 */
export class QueryBondPoolMemberDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  bakerId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  address?: string;

  @IsBoolean()
  @IsOptional()
  isManager?: boolean;

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
export const CreateBondPoolSettingsSchema = z.object({
  bakerId: z.string().min(1).max(50),
  status: z.boolean(),
});

export const UpdateBondPoolSettingsSchema = z.object({
  status: z.boolean(),
});

export const CreateBondPoolMemberSchema = z.object({
  bakerId: z.string().min(1).max(50),
  address: z.string().min(1).max(50),
  amount: z.number().min(0),
  name: z.string().max(50).optional(),
  admCharge: z.number().min(0),
  isManager: z.boolean().optional(),
});

export const UpdateBondPoolMemberSchema = z.object({
  amount: z.number().min(0).optional(),
  name: z.string().max(50).optional(),
  admCharge: z.number().min(0).optional(),
  isManager: z.boolean().optional(),
});

export const QueryBondPoolMemberSchema = z.object({
  bakerId: z.string().max(50).optional(),
  address: z.string().max(50).optional(),
  isManager: z.boolean().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

export type CreateBondPoolSettingsInput = z.infer<
  typeof CreateBondPoolSettingsSchema
>;
export type UpdateBondPoolSettingsInput = z.infer<
  typeof UpdateBondPoolSettingsSchema
>;
export type CreateBondPoolMemberInput = z.infer<
  typeof CreateBondPoolMemberSchema
>;
export type UpdateBondPoolMemberInput = z.infer<
  typeof UpdateBondPoolMemberSchema
>;
export type QueryBondPoolMemberInput = z.infer<typeof QueryBondPoolMemberSchema>;
