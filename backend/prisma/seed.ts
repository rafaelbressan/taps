import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed data for TAPS development and testing
 * Based on migration-docs/DATABASE_SCHEMA.md
 */
async function main() {
  console.log('🌱 Starting database seeding...');

  // Clean existing data (in development only)
  if (process.env.NODE_ENV === 'development') {
    console.log('🧹 Cleaning existing data...');
    await prisma.delegatorPayment.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.delegatorFee.deleteMany({});
    await prisma.bondPoolMember.deleteMany({});
    await prisma.bondPoolSettings.deleteMany({});
    await prisma.settings.deleteMany({});
  }

  // Create sample baker settings
  console.log('📝 Creating baker settings...');
  const bakerSettings = await prisma.settings.upsert({
    where: { bakerId: 'tz1abc123def456' },
    update: {},
    create: {
      bakerId: 'tz1abc123def456',
      defaultFee: new Prisma.Decimal(5.0), // 5% default fee
      updateFreq: 300, // 5 minutes
      userName: 'admin',
      passHash: '$2b$10$example.hash.placeholder',
      applicationPort: 3000,
      mode: 'simulation',
      hashSalt: 'example-salt',
      walletHash: 'example-wallet-hash',
      walletSalt: 'example-wallet-salt',
      encryptedPassphrase: 'example-encrypted-passphrase',
      appPassphrase: 'example-app-passphrase',
      delegate: '',
      proxyServer: '',
      proxyPort: 80,
      provider: 'https://rpc.ghostnet.teztnets.xyz',
      gasLimit: 15400,
      storageLimit: 300,
      transactionFee: new Prisma.Decimal(0.0018),
      blockExplorer: 'https://ghostnet.tzkt.io',
      numBlocksWait: 8,
      paymentRetries: 1,
      minBetweenRetries: 1,
    },
  });
  console.log(`✅ Created baker settings for: ${bakerSettings.bakerId}`);

  // Create sample bond pool settings
  console.log('🏊 Creating bond pool settings...');
  const bondPoolSettings = await prisma.bondPoolSettings.upsert({
    where: { bakerId: 'tz1abc123def456' },
    update: {},
    create: {
      bakerId: 'tz1abc123def456',
      status: true,
    },
  });
  console.log(`✅ Created bond pool settings (enabled: ${bondPoolSettings.status})`);

  // Create sample bond pool members
  console.log('👥 Creating bond pool members...');
  const bondPoolMembers = [
    {
      bakerId: 'tz1abc123def456',
      address: 'tz1member1abc',
      amount: new Prisma.Decimal(10000.0),
      name: 'Member One',
      admCharge: new Prisma.Decimal(50.0),
      isManager: true,
    },
    {
      bakerId: 'tz1abc123def456',
      address: 'tz1member2def',
      amount: new Prisma.Decimal(5000.0),
      name: 'Member Two',
      admCharge: new Prisma.Decimal(25.0),
      isManager: false,
    },
    {
      bakerId: 'tz1abc123def456',
      address: 'tz1member3ghi',
      amount: new Prisma.Decimal(3000.0),
      name: null,
      admCharge: new Prisma.Decimal(15.0),
      isManager: false,
    },
  ];

  for (const member of bondPoolMembers) {
    await prisma.bondPoolMember.upsert({
      where: {
        bakerId_address: {
          bakerId: member.bakerId,
          address: member.address,
        },
      },
      update: {},
      create: member,
    });
  }
  console.log(`✅ Created ${bondPoolMembers.length} bond pool members`);

  // Create sample delegator custom fees
  console.log('💰 Creating delegator custom fees...');
  const delegatorFees = [
    {
      bakerId: 'tz1abc123def456',
      address: 'tz1delegator1xyz',
      fee: new Prisma.Decimal(3.0), // Custom 3% fee
    },
    {
      bakerId: 'tz1abc123def456',
      address: 'tz1delegator2xyz',
      fee: new Prisma.Decimal(7.5), // Custom 7.5% fee
    },
    {
      bakerId: 'tz1abc123def456',
      address: 'tz1delegator3xyz',
      fee: new Prisma.Decimal(0.0), // No fee for this delegator
    },
  ];

  for (const fee of delegatorFees) {
    await prisma.delegatorFee.upsert({
      where: {
        bakerId_address: {
          bakerId: fee.bakerId,
          address: fee.address,
        },
      },
      update: {},
      create: fee,
    });
  }
  console.log(`✅ Created ${delegatorFees.length} custom delegator fees`);

  // Create sample payments
  console.log('💳 Creating sample payments...');
  const currentDate = new Date();
  const payments = [
    {
      bakerId: 'tz1abc123def456',
      cycle: 500,
      date: new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
      result: 'paid' as const,
      total: new Prisma.Decimal(125.5),
      transactionHash: 'oo1abc123def456ghi789jkl012mno345pqr678stu901',
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 501,
      date: new Date(currentDate.getTime() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      result: 'paid' as const,
      total: new Prisma.Decimal(130.25),
      transactionHash: 'oo2def456ghi789jkl012mno345pqr678stu901vwx234',
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 502,
      date: new Date(currentDate.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      result: 'rewards_delivered' as const,
      total: new Prisma.Decimal(128.75),
      transactionHash: null,
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 503,
      date: currentDate,
      result: 'rewards_pending' as const,
      total: new Prisma.Decimal(0.0),
      transactionHash: null,
    },
  ];

  for (const payment of payments) {
    await prisma.payment.create({
      data: payment,
    });
  }
  console.log(`✅ Created ${payments.length} sample payments`);

  // Create sample delegator payments
  console.log('👤 Creating sample delegator payments...');
  const delegatorPayments = [
    // Cycle 500 - Paid
    {
      bakerId: 'tz1abc123def456',
      cycle: 500,
      address: 'tz1delegator1xyz',
      date: new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000),
      result: 'applied' as const,
      total: new Prisma.Decimal(48.5),
      transactionHash: 'oo1abc123delegator1payment',
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 500,
      address: 'tz1delegator2xyz',
      date: new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000),
      result: 'applied' as const,
      total: new Prisma.Decimal(37.0),
      transactionHash: 'oo1abc123delegator2payment',
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 500,
      address: 'tz1delegator3xyz',
      date: new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000),
      result: 'applied' as const,
      total: new Prisma.Decimal(40.0),
      transactionHash: 'oo1abc123delegator3payment',
    },
    // Cycle 501 - Paid
    {
      bakerId: 'tz1abc123def456',
      cycle: 501,
      address: 'tz1delegator1xyz',
      date: new Date(currentDate.getTime() - 5 * 24 * 60 * 60 * 1000),
      result: 'applied' as const,
      total: new Prisma.Decimal(51.25),
      transactionHash: 'oo2def456delegator1payment',
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 501,
      address: 'tz1delegator2xyz',
      date: new Date(currentDate.getTime() - 5 * 24 * 60 * 60 * 1000),
      result: 'applied' as const,
      total: new Prisma.Decimal(39.0),
      transactionHash: 'oo2def456delegator2payment',
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 501,
      address: 'tz1delegator3xyz',
      date: new Date(currentDate.getTime() - 5 * 24 * 60 * 60 * 1000),
      result: 'applied' as const,
      total: new Prisma.Decimal(40.0),
      transactionHash: 'oo2def456delegator3payment',
    },
    // Cycle 502 - Simulated
    {
      bakerId: 'tz1abc123def456',
      cycle: 502,
      address: 'tz1delegator1xyz',
      date: new Date(currentDate.getTime() - 3 * 24 * 60 * 60 * 1000),
      result: 'simulated' as const,
      total: new Prisma.Decimal(50.0),
      transactionHash: null,
    },
    {
      bakerId: 'tz1abc123def456',
      cycle: 502,
      address: 'tz1delegator2xyz',
      date: new Date(currentDate.getTime() - 3 * 24 * 60 * 60 * 1000),
      result: 'simulated' as const,
      total: new Prisma.Decimal(38.75),
      transactionHash: null,
    },
  ];

  for (const payment of delegatorPayments) {
    await prisma.delegatorPayment.create({
      data: payment,
    });
  }
  console.log(`✅ Created ${delegatorPayments.length} sample delegator payments`);

  // Summary
  console.log('\n📊 Seeding Summary:');
  console.log(`   - Settings: ${await prisma.settings.count()}`);
  console.log(`   - Bond Pool Settings: ${await prisma.bondPoolSettings.count()}`);
  console.log(`   - Bond Pool Members: ${await prisma.bondPoolMember.count()}`);
  console.log(`   - Delegator Fees: ${await prisma.delegatorFee.count()}`);
  console.log(`   - Payments: ${await prisma.payment.count()}`);
  console.log(`   - Delegator Payments: ${await prisma.delegatorPayment.count()}`);
  console.log('\n✅ Database seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
