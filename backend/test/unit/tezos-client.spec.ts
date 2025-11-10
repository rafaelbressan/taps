/**
 * Tezos Client Service - Unit Tests
 *
 * Tests RPC interactions, retry logic, and fallback mechanisms
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TezosClientService } from '../../src/modules/blockchain/services/tezos-client.service';
import { TezosToolkit } from '@taquito/taquito';

describe('TezosClientService', () => {
  let service: TezosClientService;
  let mockTezos: jest.Mocked<TezosToolkit>;

  beforeEach(async () => {
    mockTezos = {
      rpc: {
        getBalance: jest.fn(),
        getBlockHeader: jest.fn(),
        getConstants: jest.fn(),
      },
      tz: {
        getBalance: jest.fn(),
      },
      setProvider: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TezosClientService,
        {
          provide: 'TEZOS_TOOLKIT',
          useValue: mockTezos,
        },
      ],
    }).compile();

    service = module.get<TezosClientService>(TezosClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getBalance', () => {
    it('should get balance successfully', async () => {
      const mockBalance = { toNumber: () => 1000000000 }; // 1000 XTZ
      mockTezos.tz.getBalance.mockResolvedValue(mockBalance as any);

      const balance = await service.getBalance('tz1test');

      expect(balance).toBe(1000);
      expect(mockTezos.tz.getBalance).toHaveBeenCalledWith('tz1test');
    });

    it('should convert mutez to XTZ correctly', async () => {
      const mockBalance = { toNumber: () => 5432100 }; // 5.432100 XTZ
      mockTezos.tz.getBalance.mockResolvedValue(mockBalance as any);

      const balance = await service.getBalance('tz1test');

      expect(balance).toBe(5.4321);
    });

    it('should retry on network failure', async () => {
      // First two calls fail, third succeeds
      mockTezos.tz.getBalance
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ toNumber: () => 1000000000 } as any);

      const balance = await service.getBalance('tz1test');

      expect(balance).toBe(1000);
      expect(mockTezos.tz.getBalance).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      mockTezos.tz.getBalance.mockRejectedValue(new Error('Network error'));

      await expect(service.getBalance('tz1test')).rejects.toThrow();
    });

    it('should handle zero balance', async () => {
      mockTezos.tz.getBalance.mockResolvedValue({ toNumber: () => 0 } as any);

      const balance = await service.getBalance('tz1test');

      expect(balance).toBe(0);
    });
  });

  describe('getCurrentCycle', () => {
    it('should calculate current cycle from block level', async () => {
      mockTezos.rpc.getBlockHeader.mockResolvedValue({
        level: 2048000, // Block level
      } as any);

      mockTezos.rpc.getConstants.mockResolvedValue({
        blocks_per_cycle: 4096,
      } as any);

      const cycle = await service.getCurrentCycle();

      // 2048000 / 4096 = 500
      expect(cycle).toBe(500);
    });

    it('should handle genesis block', async () => {
      mockTezos.rpc.getBlockHeader.mockResolvedValue({
        level: 0,
      } as any);

      mockTezos.rpc.getConstants.mockResolvedValue({
        blocks_per_cycle: 4096,
      } as any);

      const cycle = await service.getCurrentCycle();

      expect(cycle).toBe(0);
    });

    it('should cache cycle number', async () => {
      mockTezos.rpc.getBlockHeader.mockResolvedValue({
        level: 2048000,
      } as any);

      mockTezos.rpc.getConstants.mockResolvedValue({
        blocks_per_cycle: 4096,
      } as any);

      // Call twice
      await service.getCurrentCycle();
      await service.getCurrentCycle();

      // Should only call RPC once (cached)
      expect(mockTezos.rpc.getBlockHeader).toHaveBeenCalledTimes(1);
    });
  });

  describe('Retry Logic', () => {
    it('should use exponential backoff', async () => {
      const startTime = Date.now();

      mockTezos.tz.getBalance
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValue({ toNumber: () => 1000000000 } as any);

      await service.getBalance('tz1test');

      const elapsedTime = Date.now() - startTime;

      // Should have waited (exponential backoff)
      // First retry: ~1s, second retry: ~2s
      expect(elapsedTime).toBeGreaterThan(2000);
    });
  });

  describe('Fallback RPC', () => {
    it('should switch to fallback RPC on repeated failures', async () => {
      // All calls to primary RPC fail
      mockTezos.tz.getBalance.mockRejectedValue(new Error('RPC down'));

      // Mock fallback RPC success
      const fallbackMock = jest.fn().mockResolvedValue({
        toNumber: () => 1000000000,
      });

      // Inject fallback
      (service as any).fallbackTezos = {
        tz: { getBalance: fallbackMock },
      };

      const balance = await service.getBalance('tz1test');

      expect(fallbackMock).toHaveBeenCalled();
      expect(balance).toBe(1000);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid address', async () => {
      mockTezos.tz.getBalance.mockRejectedValue(
        new Error('Invalid address format'),
      );

      await expect(service.getBalance('invalid')).rejects.toThrow();
    });

    it('should handle RPC timeout', async () => {
      mockTezos.tz.getBalance.mockRejectedValue(new Error('Request timeout'));

      await expect(service.getBalance('tz1test')).rejects.toThrow();
    });

    it('should handle rate limiting', async () => {
      mockTezos.tz.getBalance.mockRejectedValue(
        new Error('Too many requests'),
      );

      await expect(service.getBalance('tz1test')).rejects.toThrow();
    });
  });
});
