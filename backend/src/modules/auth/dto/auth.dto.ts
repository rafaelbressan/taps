import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';

/**
 * Login DTO
 */
export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  password!: string;
}

/**
 * Login response
 */
export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: string;
  user: UserInfo;
}

/**
 * User information
 */
export interface UserInfo {
  baker_id: string;
  username: string;
  operation_mode: string;
}

/**
 * Change password DTO
 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword!: string;
}

/**
 * Verify wallet DTO
 */
export class VerifyWalletDto {
  @IsString()
  @IsNotEmpty()
  passphrase!: string;
}

/**
 * User response (without sensitive data)
 */
export interface UserResponse {
  baker_id: string;
  username: string;
  operation_mode: string;
  has_wallet: boolean;
}
