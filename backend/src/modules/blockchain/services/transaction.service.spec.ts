import { Test, TestingModule } from '@nestjs/testing';
import { TransactionService, BatchTransfer } from './transaction.service';
import { TezosClientService } from './tezos-client.service';
import { TEZOS_CONSTANTS, tezToMutez } from '../../../config/tezos.config';

describe('TransactionService', () => {
  let service: TransactionService;
  let tezosClient: TezosClientService;

  const mockTezosClient = {
    getToolkit: jest.fn(),
    estimateGas: jest.fn(),
    getCurrentLevel: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: TezosClientService,
          useValue: mockTezosClient,
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
    tezosClient = module.get<TezosClientService>(TezosClientService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateBatchTransfers', () => {
    it('should validate correct batch', () => {
      const transfers: BatchTransfer[] = [
        { to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', amount: 1000000 },
        { to: 'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6', amount: 2000000 },
      ];

      const result = service.validateBatchTransfers(transfers);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty batch', () => {
      const transfers: BatchTransfer[] = [];

      const result = service.validateBatchTransfers(transfers);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Batch cannot be empty');
    });

    it('should reject batch exceeding max size', () => {
      const transfers: BatchTransfer[] = [];
      for (let i = 0; i < TEZOS_CONSTANTS.MAX_BATCH_SIZE + 1; i++) {
        transfers.push({
          to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
          amount: 1000000,
        });
      }

      const result = service.validateBatchTransfers(transfers);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject negative amounts', () => {
      const transfers: BatchTransfer[] = [
        { to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', amount: -1000000 },
      ];

      const result = service.validateBatchTransfers(transfers);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('negative'))).toBe(true);
    });

    it('should reject zero amounts', () => {
      const transfers: BatchTransfer[] = [
        { to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', amount: 0 },
      ];

      const result = service.validateBatchTransfers(transfers);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('zero'))).toBe(true);
    });

    it('should reject missing recipient', () => {
      const transfers: BatchTransfer[] = [
        { to: '', amount: 1000000 },
      ];

      const result = service.validateBatchTransfers(transfers);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing recipient'))).toBe(true);
    });
  });

  describe('splitBatch', () => {
    it('should split large batch into chunks', () => {
      const transfers: BatchTransfer[] = [];
      for (let i = 0; i < 250; i++) {
        transfers.push({
          to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
          amount: 1000000,
        });
      }

      const chunks = service.splitBatch(transfers, 100);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(100);
      expect(chunks[1]).toHaveLength(100);
      expect(chunks[2]).toHaveLength(50);
    });

    it('should not split small batch', () => {
      const transfers: BatchTransfer[] = [
        { to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', amount: 1000000 },
        { to: 'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6', amount: 2000000 },
      ];

      const chunks = service.splitBatch(transfers, 100);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(2);
    });
  });

  describe('calculateBatchFee', () => {
    it('should calculate fee for batch', () => {
      const transferCount = 10;
      const fee = service.calculateBatchFee(transferCount);

      expect(fee).toBeGreaterThan(0);
      expect(typeof fee).toBe('number');
    });

    it('should scale fee with transfer count', () => {
      const fee1 = service.calculateBatchFee(1);
      const fee10 = service.calculateBatchFee(10);

      expect(fee10).toBeGreaterThan(fee1);
      expect(fee10).toBe(fee1 * 10);
    });
  });
});
