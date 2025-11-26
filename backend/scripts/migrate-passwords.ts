#!/usr/bin/env ts-node

/**
 * Password Migration Script
 *
 * Migrates user passwords from legacy SHA-512 to bcrypt hashing
 *
 * Usage:
 *   npm run migrate:passwords
 *
 * Process:
 * 1. Finds all users with legacy SHA-512 hashes (identified by having hashSalt)
 * 2. For each user, re-hashes their password using bcrypt
 * 3. Updates the database with new bcrypt hash and removes hashSalt
 *
 * NOTE: This migration CANNOT automatically migrate passwords because we don't
 * have access to plaintext passwords. Instead, it marks accounts for migration
 * and the migration happens automatically when users next log in.
 *
 * This script is primarily for:
 * - Reporting how many accounts need migration
 * - Optionally forcing password resets for security
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

interface MigrationStats {
  total: number;
  alreadyMigrated: number;
  needsMigration: number;
  failed: number;
}

async function migrateLegacyPasswords(dryRun = true): Promise<MigrationStats> {
  const stats: MigrationStats = {
    total: 0,
    alreadyMigrated: 0,
    needsMigration: 0,
    failed: 0,
  };

  console.log('🔍 Scanning for legacy password hashes...\n');

  try {
    // Find all users
    const allSettings = await prisma.settings.findMany({
      select: {
        bakerId: true,
        username: true,
        passHash: true,
        hashSalt: true,
      },
    });

    stats.total = allSettings.length;

    for (const settings of allSettings) {
      // Check if user has legacy hash (identified by presence of hashSalt)
      const isLegacyHash = settings.hashSalt !== null && settings.hashSalt !== '';
      const isBcryptHash = settings.passHash?.startsWith('$2b$') || false;

      if (!isLegacyHash && isBcryptHash) {
        stats.alreadyMigrated++;
        console.log(`✓ ${settings.username} - Already migrated to bcrypt`);
      } else if (isLegacyHash) {
        stats.needsMigration++;
        console.log(`⚠ ${settings.username} - Needs migration (SHA-512)`);

        if (!dryRun) {
          // We cannot migrate without the plaintext password
          // Migration will happen automatically on next login
          console.log(
            `  → Will be migrated automatically on next successful login`,
          );
        }
      } else {
        stats.failed++;
        console.log(`✗ ${settings.username} - Unknown hash format`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Migration Statistics:');
    console.log('='.repeat(60));
    console.log(`Total accounts:           ${stats.total}`);
    console.log(`Already migrated:         ${stats.alreadyMigrated}`);
    console.log(`Needs migration:          ${stats.needsMigration}`);
    console.log(`Unknown/failed:           ${stats.failed}`);
    console.log('='.repeat(60));

    if (stats.needsMigration > 0) {
      console.log('\n💡 Note:');
      console.log(
        'Legacy passwords will be automatically migrated to bcrypt when users',
      );
      console.log(
        'next log in successfully. No manual intervention is required.',
      );
      console.log(
        '\nThe AuthService.validateUser() method handles this migration',
      );
      console.log('transparently during the login process.');
    }

    return stats;
  } catch (error) {
    console.error('❌ Error during migration:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Optional: Force password reset for legacy accounts
 *
 * This is a more aggressive approach that marks all legacy accounts
 * as requiring password reset for security purposes.
 */
async function forcePasswordResetForLegacyAccounts(): Promise<number> {
  console.log('\n🔐 Forcing password reset for legacy accounts...\n');

  try {
    // Find all users with legacy hashes
    const legacyUsers = await prisma.settings.findMany({
      where: {
        hashSalt: {
          not: null,
        },
      },
      select: {
        bakerId: true,
        username: true,
      },
    });

    console.log(`Found ${legacyUsers.length} legacy accounts`);

    // In a real application, you would:
    // 1. Generate password reset tokens
    // 2. Send password reset emails
    // 3. Mark accounts as requiring password reset

    console.log('\n⚠️  This feature is not implemented yet.');
    console.log('To implement, you would need to:');
    console.log('  1. Add a "requirePasswordReset" field to Settings model');
    console.log('  2. Generate secure password reset tokens');
    console.log('  3. Send password reset emails to users');
    console.log('  4. Create password reset endpoint in AuthController');

    return legacyUsers.length;
  } catch (error) {
    console.error('❌ Error during forced reset:', error);
    throw error;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const forceReset = args.includes('--force-reset');

  console.log('🔐 TAPS Password Migration Tool');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (report only)' : 'EXECUTE (apply changes)'}`);
  console.log('='.repeat(60) + '\n');

  if (dryRun) {
    console.log('ℹ️  Running in DRY RUN mode (no changes will be made)');
    console.log('   Use --execute flag to apply migrations\n');
  }

  // Run migration analysis
  await migrateLegacyPasswords(dryRun);

  // Optionally force password reset
  if (forceReset) {
    await forcePasswordResetForLegacyAccounts();
  }

  console.log('\n✅ Migration analysis complete!\n');
}

// Run the migration
main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
