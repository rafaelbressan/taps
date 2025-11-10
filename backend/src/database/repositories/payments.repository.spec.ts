import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsRepository } from './payments.repository';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import { PaymentStatus } from '../../shared/constants';

describe('PaymentsRepository', () => {
  let repository: PaymentsRepository;
  let prismaService: PrismaService;

  const mockPrismaService = {
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockPayment = {
    id: 1,
    bakerId: 'tz1abc123',
    cycle: 500,
    date: new Date('2024-01-01'),
    result: 'paid',
    total: new Prisma.Decimal(125.5),
    transactionHash: 'oo1abc123def456',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsRepository,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    repository = module.get<PaymentsRepository>(PaymentsRepository);
    prismaService = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('create', () => {
    it('should create a new payment', async () => {
      mockPrismaService.payment.create.mockResolvedValue(mockPayment);

      const dto = {
        bakerId: 'tz1abc123',
        cycle: 500,
        date: '2024-01-01',
        result: PaymentStatus.PAID,
        total: 125.5,
        transactionHash: 'oo1abc123def456',
      };

      const result = await repository.create(dto);

      expect(result.id).toBe(1);
      expect(result.bakerId).toBe('tz1abc123');
      expect(mockPrismaService.payment.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('findById', () => {
    it('should return payment when found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);

      const result = await repository.findById(1);

      expect(result).toBeDefined();
      expect(result?.id).toBe(1);
    });

    it('should return null when not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      const result = await repository.findById(999);

      expect(result).toBeNull();
    });
  });

  describe('findByBakerAndCycle', () => {
    it('should return payments for baker and cycle', async () => {
      mockPrismaService.payment.findMany.mockResolvedValue([mockPayment]);

      const result = await repository.findByBakerAndCycle('tz1abc123', 500);

      expect(result).toHaveLength(1);
      expect(result[0].cycle).toBe(500);
    });
  });

  describe('findByStatus', () => {
    it('should return payments by status', async () => {
      mockPrismaService.payment.findMany.mockResolvedValue([mockPayment]);

      const result = await repository.findByStatus(PaymentStatus.PAID);

      expect(result).toHaveLength(1);
      expect(result[0].result).toBe('paid');
    });
  });

  describe('findPending', () => {
    it('should return pending payments', async () => {
      const pendingPayment = { ...mockPayment, result: 'rewards_pending' };
      mockPrismaService.payment.findMany.mockResolvedValue([pendingPayment]);

      const result = await repository.findPending();

      expect(result).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('should update payment', async () => {
      const updatedPayment = { ...mockPayment, result: 'paid' };
      mockPrismaService.payment.update.mockResolvedValue(updatedPayment);

      const result = await repository.update(1, { result: PaymentStatus.PAID });

      expect(result.result).toBe('paid');
    });
  });

  describe('delete', () => {
    it('should delete payment', async () => {
      mockPrismaService.payment.delete.mockResolvedValue(mockPayment);

      await repository.delete(1);

      expect(mockPrismaService.payment.delete).toHaveBeenCalledWith({
        where: { id: 1 },
      });
    });
  });

  describe('getTotalByBakerAndCycle', () => {
    it('should return total amount', async () => {
      mockPrismaService.payment.aggregate.mockResolvedValue({
        _sum: { total: new Prisma.Decimal(250.0) },
      });

      const result = await repository.getTotalByBakerAndCycle('tz1abc123', 500);

      expect(result).toBe(250.0);
    });

    it('should return 0 when no payments', async () => {
      mockPrismaService.payment.aggregate.mockResolvedValue({
        _sum: { total: null },
      });

      const result = await repository.getTotalByBakerAndCycle('tz1abc123', 500);

      expect(result).toBe(0);
    });
  });

  describe('findLatest', () => {
    it('should return latest payment', async () => {
      mockPrismaService.payment.findFirst.mockResolvedValue(mockPayment);

      const result = await repository.findLatest('tz1abc123');

      expect(result).toBeDefined();
      expect(result?.bakerId).toBe('tz1abc123');
    });
  });

  describe('findByCycleRange', () => {
    it('should return payments in cycle range', async () => {
      mockPrismaService.payment.findMany.mockResolvedValue([mockPayment]);

      const result = await repository.findByCycleRange('tz1abc123', 490, 510);

      expect(result).toHaveLength(1);
      expect(result[0].cycle).toBe(500);
    });
  });
});
